//! Testkit-driven simulation of the swap contracts.
//!
//! Unlike the native `test_transaction!` tests (which run against the SDK's
//! in-process executor), this drives the real contracts on a live local
//! `hog-devnode` through `groundhog-testkit`, mirroring the deploy/initialize
//! sequence in `tests/common/setup.rs`.
//!
//! First cut: a single "administrator" agent registers and deploys the five
//! contracts, initializes them, then primes the pool (the `user_buy_unpriced`
//! flow) and reads back its LP balance. A follow-up will split users out as
//! separate agents and exercise the router `add_liquidity` path.
//!
//! It is `#[ignore]`d because it needs a devnode binary and built artifacts:
//!
//! ```text
//! cd groundhog-examples
//! for c in erc20 swap swap_request swap_driver swap_router; do
//!     groundhog build -p "$c" --target-dir /tmp/swap-target
//! done
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/tmp/swap-target/groundhog \
//!     cargo test -p swap_router --test testkit_sim -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use groundhog_erc20_if::Amount;
use groundhog_testkit::rpc_types::receipt::{ExecStatus, TransactionReceipt};
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{
    Agent, AgentContext, Contract, LocalTargetConfig, Result, Scenario, TargetConfig,
};

/// On-chain address, aliased to match the contracts' `Address` type.
type Address = ContractAddress;

// Interface identities (name, version) the contracts stamped at build time, as
// recorded in each `*.spec.json`. `entrypoint_id` derives selectors from these,
// so a rebuild that changes an interface name/version is picked up here.
const ERC20: (&str, &str) = ("ERC20", "0.1.5");
const PAIR: (&str, &str) = ("ISwapV2Pair", "0.1.0");
const HANDLER: (&str, &str) = ("ISwapRequestHandler", "0.1.0");
const DRIVER: (&str, &str) = ("SwapV2Driver", "0.1.0");
const ROUTER: (&str, &str) = ("Router", "0.1.0");

/// Amount minted to the administrator per token, then supplied as liquidity.
const SUPPLY: Amount = 1_000_000_000;

/// Native (HOG) storage tokens the admin grants each contract it deploys.
///
/// The devnode has no zero-cost storage mode (unlike the SDK's
/// `TestEnvironment::no_cost()`): every account, including a contract, pays
/// native tokens for the storage it creates. A freshly deployed contract holds
/// zero, so the first time it grows its own storage the delta underflows and
/// the whole transaction is dropped at two-phase commit (`BoundsExceeded`).
/// Funding each contract up front — far above the few hundred thousand tokens a
/// typical write costs — keeps the swap flow solvent.
const CONTRACT_FUNDING: Amount = 1_000_000_000;

fn erc20(address: Address) -> Contract {
    Contract::new(address, ERC20.0, ERC20.1)
}

/// Handle to the devnode's built-in native (HOG) token precompile.
///
/// It lives at the genesis precompile address `0x00…01` and speaks the ERC20
/// interface, but vendored at `groundhog-erc20-if` 0.1.3 — so its selectors
/// derive from that version, not the 0.1.5 the deployed token contracts use.
fn native_token() -> Contract {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    Contract::new(ContractAddress::from(bytes), "ERC20", "0.1.3")
}

/// Grant `target` enough native tokens to pay for the storage it will create.
async fn fund(ctx: &mut AgentContext, native: &Contract, target: Address) -> Result<()> {
    assert_ok(
        &native
            .call(ctx, "transfer", &(target, CONTRACT_FUNDING))
            .await?,
        "fund contract",
    );
    Ok(())
}

/// Assert a state-changing call executed successfully.
fn assert_ok(receipt: &TransactionReceipt, what: &str) {
    assert!(
        matches!(receipt.status, ExecStatus::Ok),
        "{what} reverted: {:?}",
        receipt.status
    );
}

#[tokio::test]
#[ignore = "needs GROUNDHOG_DEVNODE_BINARY and built swap fixtures in GROUNDHOG_TESTKIT_ARTIFACT_ROOT"]
async fn swap_setup_and_prime() {
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!(
            "skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT to a directory with the built \
             erc20/swap/swap_request/swap_driver/swap_router .rv32a artifacts (see module docs)"
        );
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalTargetConfig::default();
    // The admin funds every contract it deploys (see CONTRACT_FUNDING), so give
    // its dev account plenty of native tokens to distribute.
    config.dev_account_tokens = 100_000_000_000;
    config.log_level = Some(groundhog_testkit::LogLevel::Trace);
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }
    if let Ok(protocol) = std::env::var("HOGD_PROTOCOL_OVERRIDE") {
        config.hogd_protocol = Some(protocol);
    }

    let scenario = Scenario::builder("swap-sim")
        .target(TargetConfig::local(config))
        .artifact("erc20", artifact("erc20.rv32a"))
        .artifact("swap", artifact("swap.wasm"))
        .artifact("swap_request", artifact("swap_request.rv32a"))
        .artifact("swap_driver", artifact("swap_driver.rv32a"))
        .artifact("swap_router", artifact("swap_router.rv32a"))
        .build()
        .await
        .expect("local node starts with the swap artifacts registered");

    let report = scenario
        .run_agents([Agent::new("admin", |mut ctx| async move {
            let me = ctx.address();
            let native = native_token();

            // --- Deploy + initialize the two A/B token contracts (owned by us).
            // The first erc20 deploy registers the binary; the second is
            // hash-only. Each contract is funded right after deploy so it can
            // pay for the storage its own state writes create. `initialize`
            // sets the administrator (mint authority).
            let token0 = erc20(ctx.deploy_artifact("erc20").await?.address);
            fund(&mut ctx, &native, token0.address()).await?;
            let token1 = erc20(ctx.deploy_artifact("erc20").await?.address);
            fund(&mut ctx, &native, token1.address()).await?;
            assert_ok(
                &token0.call(&mut ctx, "initialize", &me).await?,
                "token0.initialize",
            );
            assert_ok(
                &token1.call(&mut ctx, "initialize", &me).await?,
                "token1.initialize",
            );

            // Mint ourselves a supply of each token.
            assert_ok(
                &token0.call(&mut ctx, "mint", &(me, SUPPLY)).await?,
                "token0.mint",
            );
            assert_ok(
                &token1.call(&mut ctx, "mint", &(me, SUPPLY)).await?,
                "token1.mint",
            );

            // --- Deploy the LP token, then the pair that adopts it. The pair's
            // `initialize` takes an already-deployed, uninitialized ERC20 and
            // initializes it under the pair's control (a nested write to the LP
            // token's storage). Deploying the LP here — rather than inside the
            // pair — lets us fund it up front so that nested write is solvent.
            let lp = erc20(ctx.deploy_artifact("erc20").await?.address);
            fund(&mut ctx, &native, lp.address()).await?;
            let pair = Contract::new(ctx.deploy_artifact("swap").await?.address, PAIR.0, PAIR.1);
            fund(&mut ctx, &native, pair.address()).await?;
            assert_ok(
                &pair
                    .call(
                        &mut ctx,
                        "initialize",
                        &(me, token0.address(), token1.address(), lp.address()),
                    )
                    .await?,
                "pair.initialize",
            );

            // --- Deploy + initialize the request handler, driver, and router,
            // funding each so its own state writes are solvent.
            let handler = Contract::new(
                ctx.deploy_artifact("swap_request").await?.address,
                HANDLER.0,
                HANDLER.1,
            );
            fund(&mut ctx, &native, handler.address()).await?;
            assert_ok(
                &handler
                    .call(
                        &mut ctx,
                        "initialize",
                        &(pair.address(), token0.address(), token1.address()),
                    )
                    .await?,
                "handler.initialize",
            );

            let driver = Contract::new(
                ctx.deploy_artifact("swap_driver").await?.address,
                DRIVER.0,
                DRIVER.1,
            );
            fund(&mut ctx, &native, driver.address()).await?;
            assert_ok(
                &driver
                    .call(&mut ctx, "initialize", &handler.address())
                    .await?,
                "driver.initialize",
            );

            let router = Contract::new(
                ctx.deploy_artifact("swap_router").await?.address,
                ROUTER.0,
                ROUTER.1,
            );
            fund(&mut ctx, &native, router.address()).await?;
            assert_ok(
                &router
                    .call(
                        &mut ctx,
                        "initialize",
                        &(driver.address(), token0.address(), token1.address()),
                    )
                    .await?,
                "router.initialize",
            );

            // --- Prime the pool: transfer both tokens to the pair, then mint LP
            // to ourselves (establishing the initial price).
            assert_ok(
                &token0
                    .call(&mut ctx, "transfer", &(pair.address(), SUPPLY))
                    .await?,
                "token0.transfer",
            );
            assert_ok(
                &token1
                    .call(&mut ctx, "transfer", &(pair.address(), SUPPLY))
                    .await?,
                "token1.transfer",
            );
            assert_ok(&pair.call(&mut ctx, "mint_lp", &me).await?, "pair.mint_lp");

            // The pool minted LP tokens to us.
            let lp_balance: Amount = lp.view(&ctx, "get_balance_of", &me, None).await?;
            assert!(lp_balance > 0, "priming should mint a positive LP balance");
            println!("primed pool; LP balance = {lp_balance}");

            Ok(())
        })])
        .await
        .expect("agent runs to completion");

    assert!(report.all_ok(), "scenario failed: {report:?}");
    scenario.stop().await.expect("clean teardown");
}
