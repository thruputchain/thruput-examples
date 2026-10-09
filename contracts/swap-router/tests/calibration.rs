use std::path::PathBuf;

use groundhog_erc20_if::Amount;
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{Agent, AgentContext, LocalNetworkConfig, NetworkConfig, Result, Scenario};

// An alias to match the contracts' `Address` type.
pub type Address = ContractAddress;

mod sim;
use sim::*;

use batch_driver::GasReport;

/// Read the `GasReport` a `calibration` build's crank emits, from the receipt
/// of the transaction that cranked.
fn gas_report(receipt: &groundhog_json_rpc_types::receipt::TransactionReceipt) -> GasReport {
    use groundhog_event::Event;

    let signature = <GasReport as Event>::signature().expect("GasReport has a signature");
    let event = receipt
        .events
        .iter()
        .find(|e| e.topics.first().is_some_and(|t| &t.0 == signature))
        .expect("the crank should emit a GasReport under the calibration feature");

    let (processed, dearest_request, tail, beyond_handlers): (u32, u64, u64, u64) =
        xdrs::cxs::decode(event.data.0.as_slice()).expect("decoding the GasReport payload");

    GasReport {
        processed,
        dearest_request,
        tail,
        beyond_handlers,
    }
}

/// Queue one request of each kind, crank after each, and report what the node
/// charged. This informs the gas constants in `swap-if` and `batch-driver`.
fn calibrator(fee_enabled: bool) -> Agent {
    Agent::new("calibrator", move |mut ctx| async move {
        let native = native_token();
        let me = ctx.address();
        // The protocol fee goes wherever; what matters is whether one is set,
        // because that is what makes the pair's `mint_fee` do real work.
        let fee_to = fee_enabled.then_some(me);
        let s = deploy_and_init(&mut ctx, &native, fee_to).await?;

        // Priming is an add_liquidity of its own, and records the `k` that a
        // later liquidity event compares against.
        prime_pool(&mut ctx, &s).await?;

        // Priming deposited everything the admin held, so mint a fresh supply to
        // trade and deposit with.
        s.token0.call(&mut ctx, "mint", &(me, SUPPLY)).await?;
        s.token1.call(&mut ctx, "mint", &(me, SUPPLY)).await?;

        let mut measured: Vec<(&str, GasReport)> = Vec::new();

        // A swap, which also grows `k` through the fee it charges -- so the
        // liquidity event after it finds a grown `k` and mints the protocol fee.
        swap_a_little(&mut ctx, &s, me).await?;
        measured.push(("swap_exact_in", crank_and_report(&mut ctx, &s).await?));

        // The other swap: an exact-out solves for the input rather than being
        // handed it, so it is the one that decides `SWAP_GAS` if either does.
        swap_a_little_exact_out(&mut ctx, &s, me).await?;
        measured.push(("swap_exact_out", crank_and_report(&mut ctx, &s).await?));

        // A liquidity deposit, against a grown `k`.
        let add: Amount = SUPPLY / 1_000;
        let add_i = add;
        s.token0
            .call(&mut ctx, "adjust_allowance", &(s.handler.address(), add_i))
            .await?;
        s.token1
            .call(&mut ctx, "adjust_allowance", &(s.handler.address(), add_i))
            .await?;
        s.router
            .call(
                &mut ctx,
                "add_liquidity",
                &(
                    s.token0.address(),
                    s.token1.address(),
                    [add, add],
                    [0u128, 0u128],
                    me,
                ),
            )
            .await?;
        measured.push(("add_liquidity", crank_and_report(&mut ctx, &s).await?));

        // `mint_fee` just reset `k_last`, so grow it again before the redemption.
        swap_a_little(&mut ctx, &s, me).await?;
        s.driver.call(&mut ctx, "process_requests", &()).await?;

        let lp_balance: Amount = s.lp.view(&ctx, "get_balance_of", &me, None).await?;
        let redeem = lp_balance / 10;
        s.lp.call(&mut ctx, "adjust_allowance", &(s.handler.address(), redeem))
            .await?;
        s.router
            .call(
                &mut ctx,
                "remove_liquidity",
                &(
                    s.token0.address(),
                    s.token1.address(),
                    redeem,
                    [0u128, 0u128],
                    me,
                ),
            )
            .await?;
        measured.push(("remove_liquidity", crank_and_report(&mut ctx, &s).await?));

        let fee = if fee_enabled { "on" } else { "off" };
        println!("\n=== measured on this node (protocol fee {fee}) ===");
        println!(
            "{:<18} {:>14} {:>14} {:>16}",
            "request kind", "handler call", "tail", "beyond handlers"
        );
        for (kind, r) in &measured {
            println!(
                "{:<18} {:>14} {:>14} {:>16}",
                kind, r.dearest_request, r.tail, r.beyond_handlers
            );
        }

        Ok(())
    })
}

/// A small swap, to move the reserves (and so grow `k`).
async fn swap_a_little(ctx: &mut AgentContext, s: &Swap, me: Address) -> Result<()> {
    let amount_in: Amount = SUPPLY / 1_000;
    s.token0
        .call(ctx, "adjust_allowance", &(s.handler.address(), amount_in))
        .await?;
    s.router
        .call(
            ctx,
            "swap_exact_tokens_for_tokens",
            &(amount_in, 0u128, s.token0.address(), s.token1.address(), me),
        )
        .await?;
    Ok(())
}

/// A small exact-out swap, naming the output and capping the input.
async fn swap_a_little_exact_out(ctx: &mut AgentContext, s: &Swap, me: Address) -> Result<()> {
    let amount_out: Amount = SUPPLY / 1_000;
    // The handler pulls whatever the curve says the output costs, which it
    // learns only at execution; the allowance has to cover the cap we set.
    let amount_in_max: Amount = SUPPLY / 100;
    s.token0
        .call(
            ctx,
            "adjust_allowance",
            &(s.handler.address(), amount_in_max),
        )
        .await?;
    s.router
        .call(
            ctx,
            "swap_tokens_for_exact_tokens",
            &(
                amount_out,
                amount_in_max,
                s.token0.address(),
                s.token1.address(),
                me,
            ),
        )
        .await?;
    Ok(())
}

async fn crank_and_report(ctx: &mut AgentContext, s: &Swap) -> Result<GasReport> {
    let receipt = s.driver.call(ctx, "process_requests", &()).await?;

    // A failed request still costs gas, so measuring one would quietly report
    // the cost of the failure path instead of the work.
    // The account's default wallet ran the call and returns one buffer per
    // call it made; unwrap that envelope before decoding the counts.
    let returned = receipt
        .return_data
        .as_ref()
        .map(|d| {
            groundhog_signing::default_wallet::decode_default_wallet_call_return(d.0.as_slice())
                .expect("unwrapping the wallet's return")
        })
        .expect("process_requests returns counts");
    let counts: (u32, u32) =
        xdrs::cxs::decode(returned.as_slice()).expect("decoding (processed, failed)");
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
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    config.initial_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }

    let scenario = Scenario::builder("swap-gas-calibration")
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
        .run_agents([calibrator(fee_enabled)])
        .await
        .expect("calibration runs to completion");
}
