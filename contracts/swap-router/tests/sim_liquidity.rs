//! Testkit-driven simulation of the swap contracts.
//!
//! Unlike the native `test_transaction!` tests (which run against the SDK's
//! in-process executor), this drives the real contracts on a live local
//! `hog-devnode` using `groundhog-testkit`.
//!
//! An `admin` agent deploys the factory and router, has the factory create the
//! pool and then primes it through the router with `add_liquidity`. The admin
//! also acts as the request-queue operator. Two independent liquidity providers
//! (`alice`, `bob`) each run as their own agent: they learn the contract
//! addresses over the harness mailbox, approve the request handler, submit an
//! `add_liquidity` request through the router, and (once the admin has driven
//! the queue) confirm they were minted LP.
//!
//! It is `#[ignore]`d because it needs the groundhog CLI and built artifacts.
//! `scripts/swap-sim.sh` wires up both. Roughly:
//!
//! ```shell
//! cd groundhog-examples
//! for c in erc20 swap-handler swap-driver swap-router swap-factory; do groundhog build -p "$c"; done
//! RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info" \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/path/to/target/groundhog \
//!     cargo test -p swap-router --test sim_liquidity -- --ignored --no-capture
//! ```

use std::path::PathBuf;

use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{Agent, LocalNetworkConfig, NetworkConfig, Scenario};

// An alias to match the contracts' `Address` type.
pub type Address = ContractAddress;

mod sim;
use sim::*;

// A liquidity-provider agent:
//
// * Greets the admin (requesting configuration and airdropped tokens)
// * Receives the contract addresses
// * Approves the request handler
// * Submits an `add_liquidity` request through the router
// * Once the admin signals the queue is driven, confirms it was minted LP
//
fn liquidity_provider(name: &str) -> Agent {
    Agent::new(name, |mut ctx| async move {
        let me = ctx.address();

        // Announce ourselves so the admin can mint us A/B tokens and send the
        // contract addresses we need.
        ctx.send("admin", &me)?;

        // Receive configuration from the admin.
        let cfg: LPConfig = ctx
            .recv_from("admin")
            .await
            .expect("bug: admin closed before sending addresses")?
            .body;
        let token0 = ERC20Client::new(&ctx, cfg.token0);
        let token1 = ERC20Client::new(&ctx, cfg.token1);
        let router = SwapRouterClient::new(&ctx, cfg.router);
        let lp = ERC20Client::new(&ctx, cfg.lp);

        // Allow the request handler to pull our A/B tokens when the request runs.
        token0
            .adjust_allowance(&cfg.handler, USER_LIQUIDITY)
            .await?;
        token1
            .adjust_allowance(&cfg.handler, USER_LIQUIDITY)
            .await?;

        // Submit an add-liquidity request (executed below, by the driver),
        // purchasing LP tokens with our A/B tokens.
        let desired = [swap_amount(USER_LIQUIDITY); 2];
        router
            .add_liquidity(&cfg.token0, &cfg.token1, desired, [0, 0], &me)
            .await?;

        // Tell the admin our request is queued, then wait for confirmation that
        // it has been driven.
        ctx.send("admin", &())?;
        ctx.recv_from::<()>("admin")
            .await
            .expect("bug: admin closed before driving requests")?;

        // Check that we received LP.
        let lp_balance = lp.get_balance_of(&me).await?;
        assert!(
            lp_balance > 0,
            "add_liquidity should mint LP to the provider"
        );
        println!("{}: received {lp_balance} LP", ctx.name());
        Ok(())
    })
}

// The admin agent:
// * Sets up the suite
// * Operates the request queue for the providers
fn admin() -> Agent {
    Agent::new("admin", |mut ctx| async move {
        let native = native_token(&ctx);
        let s = deploy_and_init(&ctx, &native, None).await?;
        prime_pool(&ctx, &s).await?;

        // Learn the providers' wallet addresses from their greetings.
        let mut providers: Vec<(String, Address)> = Vec::new();
        for _ in 0..PROVIDERS.len() {
            let hello = ctx
                .recv_from_any::<Address>(&PROVIDERS)
                .await
                .expect("bug: a provider closed before greeting")?;
            providers.push((hello.from, hello.body));
        }

        // Airdrop A/B tokens to each provider, then send the contract addresses.
        let config = LPConfig::of(&s);
        for (name, addr) in &providers {
            s.token0.mint(addr, USER_LIQUIDITY).await?;
            s.token1.mint(addr, USER_LIQUIDITY).await?;
            ctx.send(name, &config)?;
        }

        // Wait for the providers to signal that their requests are queued.
        for _ in 0..PROVIDERS.len() {
            ctx.recv_from_any::<()>(&PROVIDERS)
                .await
                .expect("bug: a provider closed before submitting")?;
        }

        // Drive the queue, processing the providers' add-liquidity requests
        let (processed, failed) = s.driver.process_requests().await?;
        assert_eq!(
            (processed, failed),
            (PROVIDERS.len() as u32, 0),
            "every queued request should process without failure"
        );

        // Release the providers to verify their balances.
        for (name, _) in &providers {
            ctx.send(name, &())?;
        }
        Ok(())
    })
}

// Run a scenario with the admin and liquidity providers
#[tokio::test]
#[ignore = "needs built swap fixtures in GROUNDHOG_TESTKIT_ARTIFACT_ROOT"]
async fn swap_liquidity_multi_agent() {
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!(
            "skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT to a directory with the built \
             erc20/swap/swap_handler/swap_driver/swap_router/swap_factory artifacts (see module docs)"
        );
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    // The admin funds every contract it deploys (see CONTRACT_FUNDING), so give its dev account
    // plenty of native tokens to distribute.
    config.dev_account_tokens = 100_000_000_000;
    // Optional override
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }
    if std::env::var("RUST_LOG").is_ok() {
        config.log_level = Some(groundhog_testkit::LogLevel::Info);
    }

    let scenario = Scenario::builder("swap-sim")
        .bootstrap_accounts()
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
        .run_agents([
            admin(),
            liquidity_provider(PROVIDERS[0]),
            liquidity_provider(PROVIDERS[1]),
        ])
        .await
        .expect("agents run to completion");

    scenario.stop().await.expect("clean teardown");
}
