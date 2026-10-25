use std::path::PathBuf;

use thruput_erc20_if::Amount;
use thruput_testkit::xdr::types::ContractAddress;
use thruput_testkit::{Agent, LocalNetworkConfig, NetworkConfig, Result, Scenario};

// An alias to match the contracts' `Address` type.
pub type Address = ContractAddress;

mod sim;
use sim::*;

use batch_driver::GasReport;

type Receipt = thruput_json_rpc_types::responses::TransactionReceipt;

/// The payload of the first event of type `E` in `receipt`, if any.
fn event_data<E: thruput_event::Event>(receipt: &Receipt) -> Option<&[u8]> {
    let signature = E::signature().expect("the event has a signature");
    receipt
        .events
        .iter()
        .find(|e| e.topics.first().is_some_and(|t| &t.0 == signature))
        .map(|e| e.data.0.as_slice())
}

/// Read the `GasReport` a `calibration` build's crank emits, from the receipt
/// of the transaction that cranked.
fn gas_report(receipt: &Receipt) -> GasReport {
    let data = event_data::<GasReport>(receipt)
        .expect("the crank should emit a GasReport under the calibration feature");

    let (processed, claim, dearest_request, tail, beyond_handlers): (u32, u64, u64, u64, u64) =
        xdrs::cxs::decode(data).expect("decoding the GasReport payload");

    GasReport {
        processed,
        claim,
        dearest_request,
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
    let (counts, receipt) = s.driver.process_requests().with_receipt().await?;

    // A failed request still costs gas, so measuring one would quietly report
    // the cost of the failure path instead of the work.
    assert_eq!(
        counts,
        (1, 0),
        "the crank should have processed exactly one request, and it should have succeeded"
    );

    Ok(gas_report(&receipt))
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

async fn run_calibration(fee_enabled: bool) {
    run_scenario("swap_driver", calibrator(fee_enabled)).await;
}

// Run `agent` on a local node with the swap suite registered, the factory's driver being the
// artifact `driver` (`swap_driver`, `swap_gsr_driver` or `swap_clvr_driver`).
async fn run_scenario(driver: &str, agent: Agent) {
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

    let scenario = Scenario::builder("swap-gas-calibration")
        .network(NetworkConfig::local(config))
        .artifact("erc20", artifact("erc20.rv32a"))
        .artifact("swap_handler", artifact("swap_handler.rv32a"))
        .artifact("swap_driver", artifact(&format!("{driver}.rv32a")))
        .artifact("swap_router", artifact("swap_router.rv32a"))
        .artifact("swap_factory", artifact("swap_factory.rv32a"))
        .artifact("clvr_bench", artifact("clvr_bench.rv32a"))
        .build()
        .await
        .expect("local node starts with the swap artifacts registered");

    scenario
        .run_agents([agent])
        .await
        .expect("calibration runs to completion");
}

/////////////////////// ordering drivers ////////////////////////////////////

/// Queue batches of swaps -- both directions, both kinds -- crank each, and report what the node
/// charged. An ordering driver's `beyond handlers`, less `swap-driver`'s for the same batch, is
/// what the ordering cost: this informs `swap-gsr-driver`'s `PICK_GAS` and `swap-clvr-driver`'s
/// `SEQUENCE_GAS`.
///
/// The testkit declares 10M gas on every call, which caps a batch at five requests; how the
/// ordering's cost grows past that is what `measure_clvr_ordering` is for.
fn ordered_calibrator(driver: &'static str) -> Agent {
    Agent::new("calibrator", move |mut ctx| async move {
        let native = native_token(&ctx);
        let me = ctx.address();
        let s = deploy_and_init(&mut ctx, &native, None).await?;
        prime_pool(&ctx, &s).await?;

        s.token0.mint(&me, SUPPLY).await?;
        s.token1.mint(&me, SUPPLY).await?;
        s.token0.adjust_allowance(&s.handler, SUPPLY).await?;
        s.token1.adjust_allowance(&s.handler, SUPPLY).await?;

        let tokens = [s.token0.address(), s.token1.address()];
        println!("\n=== {driver}: measured on this node ===");
        println!(
            "{:>5} {:>10} {:>14} {:>16}",
            "batch", "claim", "handler call", "beyond handlers"
        );

        for batch in [1u32, 2, 5] {
            for i in 0..batch {
                let (token_in, token_out) =
                    (tokens[(i % 2) as usize], tokens[1 - (i % 2) as usize]);
                let amount = SUPPLY / 1_000 * Amount::from(1 + i);
                if i / 2 % 2 == 0 {
                    s.router
                        .swap_exact_tokens_for_tokens(
                            swap_amount(amount),
                            0,
                            &token_in,
                            &token_out,
                            &me,
                        )
                        .await?;
                } else {
                    s.router
                        .swap_tokens_for_exact_tokens(
                            swap_amount(amount / 2),
                            swap_amount(SUPPLY / 10),
                            &token_in,
                            &token_out,
                            &me,
                        )
                        .await?;
                }
            }

            let (counts, receipt) = s.driver.process_requests().with_receipt().await?;
            assert_eq!(
                counts,
                (batch, 0),
                "the whole batch should process, and succeed"
            );

            let g = gas_report(&receipt);
            println!(
                "{:>5} {:>10} {:>14} {:>16}",
                batch, g.claim, g.dearest_request, g.beyond_handlers
            );
        }

        Ok(())
    })
}

#[tokio::test]
#[ignore = "needs calibration-built swap fixtures"]
async fn calibrate_ordered_crank_gas() {
    for driver in ["swap_driver", "swap_gsr_driver", "swap_clvr_driver"] {
        run_scenario(driver, ordered_calibrator(driver)).await;
    }
}

/// What `clvr-bench`'s `order` reports.
#[derive(Debug, thruput_testkit::xdrs::ReadXDR)]
#[xdrs(crate = "thruput_testkit::xdrs")]
struct OrderingCost {
    setup: u64,
    dearest_step: u64,
    steps: u64,
}

/// Order synthetic batches, up to past the most a crank takes (`clvr::MAX_BATCH`), with the same
/// CLVR code a crank runs, and report what the node charged: how the ordering's share of
/// `SEQUENCE_GAS` grows with the batch. (Much past 128 the fixture outgrows its memory.)
fn clvr_bench() -> Agent {
    Agent::new("clvr-bench", move |mut ctx| async move {
        let funded = thruput_testkit::DeployOptions::funded(CONTRACT_FUNDING as u128);
        let bench = ctx.deploy_artifact("clvr_bench", funded).await?.address;
        let bench = thruput_testkit::Contract::new(bench, "ClvrBench", "0.1.0");
        let me = Some(ctx.address());

        println!("\n=== CLVR ordering, measured on this node ===");
        println!(
            "{:>5} {:>12} {:>12} {:>14} {:>12} {:>14}",
            "batch", "batch kind", "setup", "dearest step", "steps", "per request"
        );
        for n in [1u32, 8, 32, 64, 112, 128] {
            for adversarial in [false, true] {
                let depth: swap_if::Amount = 1 << 80;
                let cost: Result<OrderingCost> = bench
                    .view(ctx.caller(), "order", &(n, depth, adversarial), me)
                    .await;
                // A batch can outgrow the guest's memory.
                let Ok(cost) = cost else {
                    println!(
                        "{n:>5} {:>12} {cost:?}",
                        if adversarial { "one-sided" } else { "mixed" }
                    );
                    continue;
                };
                println!(
                    "{:>5} {:>12} {:>12} {:>14} {:>12} {:>14}",
                    n,
                    if adversarial { "one-sided" } else { "mixed" },
                    cost.setup,
                    cost.dearest_step,
                    cost.steps,
                    (cost.setup + cost.steps) / u64::from(n),
                );
            }
        }

        Ok(())
    })
}

#[tokio::test]
#[ignore = "needs the clvr-bench fixture built"]
async fn measure_clvr_ordering() {
    run_scenario("swap_driver", clvr_bench()).await;
}
