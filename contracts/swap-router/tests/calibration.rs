use std::path::PathBuf;

use thruput_erc20_if::Amount;
use thruput_testkit::xdr::types::ContractAddress;
use thruput_testkit::{
    Agent, AgentContext, LocalNetworkConfig, NetworkConfig, Result, Scenario, xdrs,
};

// An alias to match the contracts' `Address` type.
pub type Address = ContractAddress;

mod sim;
use sim::*;

use batch_driver::GasReport;

/// Read the `GasReport` a `calibration` build's crank emits, from the receipt
/// of the transaction that cranked.
fn gas_report(receipt: &thruput_json_rpc_types::responses::TransactionReceipt) -> GasReport {
    use thruput_event::Event;

    let signature = <GasReport as Event>::signature().expect("GasReport has a signature");
    let event = receipt
        .events
        .iter()
        .find(|e| e.topics.first().is_some_and(|t| &t.0 == signature))
        .expect("the crank should emit a GasReport under the calibration feature");

    let (processed, claim, dearest_request, handlers_total, tail, beyond_handlers): (
        u32,
        u64,
        u64,
        u64,
        u64,
        u64,
    ) = xdrs::cxs::decode(event.data.0.as_slice()).expect("decoding the GasReport payload");

    GasReport {
        processed,
        claim,
        dearest_request,
        handlers_total,
        tail,
        beyond_handlers,
    }
}

/// Queue one request of each kind, crank after each, and report what the node
/// charged. This informs the gas constants in `swap-if` and `batch-driver`.
fn calibrator(fee_enabled: bool) -> Agent {
    Agent::new("calibrator", move |mut ctx| async move {
        let native = native_token(&ctx);
        let me = ctx.address();
        // The protocol fee goes wherever; what matters is whether one is set,
        // because that is what makes the pair's `mint_fee` do real work.
        let fee_to = fee_enabled.then_some(me);
        let s = deploy_and_init(&mut ctx, &native, fee_to).await?;

        // Priming is an add_liquidity of its own, and records the `k` that a
        // later liquidity event compares against.
        prime_pool(&ctx, &s).await?;

        // Priming deposited everything the admin held, so mint a fresh supply to
        // trade and deposit with.
        s.token0.mint(&me, SUPPLY).await?;
        s.token1.mint(&me, SUPPLY).await?;

        let mut measured: Vec<(&str, GasReport)> = Vec::new();

        // A swap, which also grows `k` through the fee it charges -- so the
        // liquidity event after it finds a grown `k` and mints the protocol fee.
        swap_a_little(&s, me).await?;
        measured.push(("swap_exact_in", crank_and_report(&s).await?));

        // The other swap: an exact-out solves for the input rather than being
        // handed it, so it is the one that decides `SWAP_GAS` if either does.
        swap_a_little_exact_out(&s, me).await?;
        measured.push(("swap_exact_out", crank_and_report(&s).await?));

        // A liquidity deposit, against a grown `k`.
        let add: Amount = SUPPLY / 1_000;
        s.token0.adjust_allowance(&s.handler, add).await?;
        s.token1.adjust_allowance(&s.handler, add).await?;
        s.router
            .add_liquidity(
                &s.token0.address(),
                &s.token1.address(),
                [swap_amount(add); 2],
                [0, 0],
                &me,
            )
            .await?;
        measured.push(("add_liquidity", crank_and_report(&s).await?));

        // `mint_fee` just reset `k_last`, so grow it again before the redemption.
        swap_a_little(&s, me).await?;
        s.driver.process_requests().await?;

        let lp_balance = s.lp.get_balance_of(&me).await?;
        let redeem = lp_balance / 10;
        s.lp.adjust_allowance(&s.handler, redeem).await?;
        s.router
            .remove_liquidity(
                &s.token0.address(),
                &s.token1.address(),
                swap_amount(redeem),
                [0, 0],
                &me,
            )
            .await?;
        measured.push(("remove_liquidity", crank_and_report(&s).await?));

        let fee = if fee_enabled { "on" } else { "off" };
        println!("\n=== measured on this node (protocol fee {fee}) ===");
        println!(
            "{:<18} {:>10} {:>14} {:>14} {:>16}",
            "request kind", "claim", "handler call", "tail", "beyond handlers"
        );
        for (kind, r) in &measured {
            println!(
                "{:<18} {:>10} {:>14} {:>14} {:>16}",
                kind, r.claim, r.dearest_request, r.tail, r.beyond_handlers
            );
        }

        Ok(())
    })
}

/// A small swap, to move the reserves (and so grow `k`).
async fn swap_a_little(s: &Swap, me: Address) -> Result<()> {
    let amount_in: Amount = SUPPLY / 1_000;
    s.token0.adjust_allowance(&s.handler, amount_in).await?;
    s.router
        .swap_exact_tokens_for_tokens(
            swap_amount(amount_in),
            0,
            &s.token0.address(),
            &s.token1.address(),
            &me,
        )
        .await?;
    Ok(())
}

/// A small exact-out swap, naming the output and capping the input.
async fn swap_a_little_exact_out(s: &Swap, me: Address) -> Result<()> {
    let amount_out: Amount = SUPPLY / 1_000;
    // The handler pulls whatever the curve says the output costs, which it
    // learns only at execution; the allowance has to cover the cap we set.
    let amount_in_max: Amount = SUPPLY / 100;
    s.token0.adjust_allowance(&s.handler, amount_in_max).await?;
    s.router
        .swap_tokens_for_exact_tokens(
            swap_amount(amount_out),
            swap_amount(amount_in_max),
            &s.token0.address(),
            &s.token1.address(),
            &me,
        )
        .await?;
    Ok(())
}

async fn crank_and_report(s: &Swap) -> Result<GasReport> {
    crank_batch_and_report(s, 1).await
}

async fn crank_batch_and_report(s: &Swap, batch: u32) -> Result<GasReport> {
    let (counts, receipt) = s.driver.process_requests().with_receipt().await?;

    // A failed request still costs gas, so measuring one would quietly report
    // the cost of the failure path instead of the work.
    assert_eq!(
        counts,
        (batch, 0),
        "the crank should have processed exactly {batch} requests, all successfully"
    );

    Ok(gas_report(&receipt))
}

// The swappers of the batched calibration, each its own account. Fewer than the
// factory's `MIN_CRANK_BATCH`, so that one crank with the testkit's gas can
// drain them all.
const SWAPPERS: [&str; 4] = ["s1", "s2", "s3", "s4"];

// The addresses a swapper needs, sent to it over the mailbox.
#[derive(Debug, Clone, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "thruput_testkit::xdrs")]
struct SwapperConfig {
    token0: Address,
    token1: Address,
    handler: Address,
    router: Address,
}

/// Crank a batch of swaps at once, and report what its later requests cost
/// beside its first.
///
/// A transaction pays for a storage key's database load only on its first
/// touch of it, so the first request in a batch loads the pool's state (its
/// configuration, its reserves, its own token balances) and the rest find
/// those warm. What each later request still loads is its own traders'
/// balances and allowance -- unless they are the same accounts as an earlier
/// request's, which is why this runs a batch from distinct swappers and then
/// one from a single account.
fn batch_calibrator() -> Agent {
    Agent::new("calibrator", move |mut ctx| async move {
        let native = native_token(&ctx);
        let me = ctx.address();
        let s = deploy_and_init(&mut ctx, &native, None).await?;
        prime_pool(&ctx, &s).await?;
        s.token0.mint(&me, SUPPLY).await?;

        let config = SwapperConfig {
            token0: s.token0.address(),
            token1: s.token1.address(),
            handler: s.handler,
            router: s.router.address(),
        };
        for _ in SWAPPERS {
            let hello = ctx
                .recv_from_any::<Address>(&SWAPPERS)
                .await
                .expect("bug: a swapper closed before greeting")?;
            s.token0.mint(&hello.body, SUPPLY / 100).await?;
            ctx.send(&hello.from, &config)?;
        }

        // Each swapper reports once its request is queued.
        for _ in SWAPPERS {
            ctx.recv_from_any::<()>(&SWAPPERS)
                .await
                .expect("bug: a swapper closed before queueing")?;
        }
        let distinct = crank_batch_and_report(&s, SWAPPERS.len() as u32).await?;

        for _ in SWAPPERS {
            swap_a_little(&s, me).await?;
        }
        let repeated = crank_batch_and_report(&s, SWAPPERS.len() as u32).await?;

        println!(
            "\n=== a batch of {} swaps, measured on this node ===",
            SWAPPERS.len()
        );
        println!(
            "{:<20} {:>14} {:>14} {:>16}",
            "swappers", "first request", "each later", "beyond handlers"
        );
        for (kind, r) in [("distinct", &distinct), ("one account", &repeated)] {
            // The first request is the dearest: it loads what the rest reuse.
            let later = (r.handlers_total - r.dearest_request) / u64::from(r.processed - 1);
            println!(
                "{:<20} {:>14} {:>14} {:>16}",
                kind, r.dearest_request, later, r.beyond_handlers
            );
        }

        Ok(())
    })
}

/// Join the batched calibration: get funded, approve the handler, and queue one
/// swap.
fn swapper(name: &'static str) -> Agent {
    Agent::new(name, move |mut ctx| async move {
        let me = ctx.address();
        let cfg = join_calibrator(&mut ctx).await?;
        let token0 = ERC20Client::new(&ctx, cfg.token0);
        let router = SwapRouterClient::new(&ctx, cfg.router);

        let amount_in: Amount = SUPPLY / 1_000;
        token0.adjust_allowance(&cfg.handler, amount_in).await?;
        router
            .swap_exact_tokens_for_tokens(swap_amount(amount_in), 0, &cfg.token0, &cfg.token1, &me)
            .await?;

        ctx.send("calibrator", &())?;
        Ok(())
    })
}

async fn join_calibrator(ctx: &mut AgentContext) -> Result<SwapperConfig> {
    ctx.send("calibrator", &ctx.address())?;
    Ok(ctx
        .recv_from("calibrator")
        .await
        .expect("bug: the calibrator closed before sending addresses")?
        .body)
}

#[tokio::test]
#[ignore = "needs calibration-built swap fixtures"]
async fn calibrate_crank_gas() {
    // Twice, because the pair's `mint_fee` only does real work when a protocol
    // fee is configured -- a square root and some U256 arithmetic on every
    // liquidity event -- and the liquidity budgets have to cover that too.
    for fee_enabled in [false, true] {
        run_calibration(fee_enabled).await;
    }
}

#[tokio::test]
#[ignore = "needs calibration-built swap fixtures"]
async fn calibrate_batch_gas() {
    let mut agents = vec![batch_calibrator()];
    agents.extend(SWAPPERS.map(swapper));
    run_agents("swap-batch-gas-calibration", agents).await;
}

async fn run_calibration(fee_enabled: bool) {
    run_agents("swap-gas-calibration", [calibrator(fee_enabled)]).await;
}

async fn run_agents(name: &str, agents: impl IntoIterator<Item = Agent>) {
    let Ok(root) = std::env::var("THRUPUT_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set THRUPUT_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    config.initial_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("THRUPUT_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }

    let scenario = Scenario::builder(name)
        .network(NetworkConfig::local(config))
        .artifact("erc20", artifact("erc20.rv32a"))
        .artifact("swap_handler", artifact("swap_handler.rv32a"))
        .artifact("swap_driver", artifact("swap_driver.rv32a"))
        .artifact("swap_router", artifact("swap_router.rv32a"))
        .artifact("swap_factory", artifact("swap_factory.rv32a"))
        .build()
        .await
        .expect("local node starts with the swap artifacts registered");

    scenario
        .run_agents(agents)
        .await
        .expect("calibration runs to completion");
}
