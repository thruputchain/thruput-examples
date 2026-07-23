//! Testkit-driven simulation of the swap contracts.
//!
//! Unlike the native `test_transaction!` tests (which run against the SDK's
//! in-process executor), this drives the real contracts on a live local
//! `hog-devnode` using `groundhog-testkit`.
//!
//! An `admin` agent deploys and initializes the contract suite, primes the
//! pool, and acts as the request-queue operator. Two independent liquidity
//! providers (`alice`, `bob`) each run as their own agent: they learn the
//! contract addresses over the harness mailbox, approve the request handler,
//! submit an `add_liquidity` request through the router, and — once the admin
//! has driven the queue — confirm they were minted LP.
//!
//! It is `#[ignore]`d because it needs a devnode binary and built artifacts.
//! `scripts/run-swap-sim.sh` wires up both. Roughly:
//!
//! ```text
//! cd groundhog-examples
//! for c in erc20 swap-request swap-driver swap-router swap-factory; do groundhog build -p "$c"; done
//! groundhog build -p swap-pair --target wasm   # swap does not build for rv32a yet
//! RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info" \
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/path/to/target/groundhog \
//!     cargo test -p swap-router --test testkit_sim -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use groundhog_erc20_if::Amount;
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{
    Agent, AgentContext, Contract, LocalNetworkConfig, NetworkConfig, Result, Scenario, xdrs,
};
use swap_if::{Suite, SwapHashes};

/// An alias to match the contracts' `Address` type.
type Address = ContractAddress;

// Interface identities (name, version) the contracts stamped at build time, as
// recorded in each `*.spec.json`. `entrypoint_id` derives selectors from
// these.
const ERC20: (&str, &str) = ("ERC20", "0.1.5");
const PAIR: (&str, &str) = ("SwapPair", "0.1.0");
const HANDLER: (&str, &str) = ("SwapRequestHandler", "0.1.0");
const DRIVER: (&str, &str) = ("SwapDriver", "0.1.0");
const ROUTER: (&str, &str) = ("Router", "0.1.0");
const FACTORY: (&str, &str) = ("SwapFactory", "0.1.0");

/// The liquidity providers, each run as its own agent.
const PROVIDERS: [&str; 2] = ["alice", "bob"];

/// Amount the admin mints itself per token, then supplies to prime the pool.
const SUPPLY: Amount = 1_000_000_000;

/// Amount of each token the admin airdrops to a provider, which the provider
/// then contributes as liquidity. Small relative to `SUPPLY` so the priced
/// pool absorbs it at roughly the established 1:1 ratio.
const USER_LIQUIDITY: Amount = 1_000_000;

/// Native (HOG) storage tokens the admin grants each contract it deploys.
///
/// A contract must pay native tokens for the storage it creates. Funding each
/// contract up front — far above the few hundred thousand tokens a typical
/// write costs — keeps the swap flow solvent.
const CONTRACT_FUNDING: Amount = 1_000_000_000;

/// The contract suite
struct Swap {
    token0: Contract,
    token1: Contract,
    lp: Contract,
    pair: Contract,
    handler: Contract,
    driver: Contract,
    router: Contract,
}

/// An ERC20 contract for token0, token1, and lp
fn erc20(address: Address) -> Contract {
    Contract::new(address, ERC20.0, ERC20.1)
}

/// The devnode's native token contract.
///
/// It lives at the genesis precompile address `0x00…01` and speaks the ERC20
/// interface, vendored at `groundhog-erc20-if` 0.1.3.
fn native_token() -> Contract {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    Contract::new(ContractAddress::from(bytes), "ERC20", "0.1.3")
}

/// Grant `target` enough native tokens to pay for the storage it will create.
async fn fund(ctx: &mut AgentContext, native: &Contract, target: Address) -> Result<()> {
    native
        .call(ctx, "transfer", &(target, CONTRACT_FUNDING))
        .await?;
    Ok(())
}

/// The contract addresses a provider needs, sent to it over the mailbox.
#[derive(Debug, Clone, xdrs::WriteXDR, xdrs::ReadXDR)]
// `xdrs` reaches us re-exported through the testkit, not as a direct crate, so
// point the derives' generated code at that path.
#[xdr(crate = "groundhog_testkit::xdrs")]
struct LPConfig {
    token0: Address,
    token1: Address,
    handler: Address,
    router: Address,
    lp: Address,
}

impl LPConfig {
    fn of(s: &Swap) -> Self {
        Self {
            token0: s.token0.address(),
            token1: s.token1.address(),
            handler: s.handler.address(),
            router: s.router.address(),
            lp: s.lp.address(),
        }
    }
}

/// As admin: register the suite's code, deploy the tokens and the factory, then
/// have the factory create and wire the whole suite in one transaction.
async fn deploy_and_init(ctx: &mut AgentContext, native: &Contract) -> Result<Swap> {
    let me = ctx.address();

    // Register the code the factory will deploy by hash.  (erc20 registers when
    // we deploy the tokens below; the rest we register explicitly, since the
    // factory -- not us -- deploys their instances.)
    ctx.register_artifact("swap_pair").await?;
    ctx.register_artifact("swap_request").await?;
    ctx.register_artifact("swap_driver").await?;
    ctx.register_artifact("swap_router").await?;

    // The two A/B token contracts (owned by us).  Each is funded right after
    // deploy so it can pay for the storage its state writes create.
    let token0 = erc20(ctx.deploy_artifact("erc20").await?.address);
    fund(ctx, native, token0.address()).await?;
    let token1 = erc20(ctx.deploy_artifact("erc20").await?.address);
    fund(ctx, native, token1.address()).await?;
    token0.call(ctx, "initialize", &me).await?;
    token1.call(ctx, "initialize", &me).await?;

    // Mint ourselves a supply of each token, used below to prime the pool.
    token0.call(ctx, "mint", &(me, SUPPLY)).await?;
    token1.call(ctx, "mint", &(me, SUPPLY)).await?;

    // Deploy, fund, and initialize the factory with the code hashes it needs
    // and the protocol fee disabled.
    let factory = Contract::new(
        ctx.deploy_artifact("swap_factory").await?.address,
        FACTORY.0,
        FACTORY.1,
    );
    fund(ctx, native, factory.address()).await?;

    let hashes = SwapHashes {
        token: ctx.contract_hash("erc20")?,
        pair: ctx.contract_hash("swap_pair")?,
        handler: ctx.contract_hash("swap_request")?,
        driver: ctx.contract_hash("swap_driver")?,
        router: ctx.contract_hash("swap_router")?,
    };
    let fee_to: Option<Address> = None;
    factory.call(ctx, "initialize", &(hashes, fee_to)).await?;

    // Ask the factory where it will deploy the suite, and fund each of those
    // addresses: `create_pair` deploys *and* initializes them in one
    // transaction, so each child must already be solvent to pay for its init
    // writes.
    let (t0, t1) = (token0.address(), token1.address());
    let suite: Suite = factory.view(ctx, "predict_pair", &(t0, t1), None).await?;
    fund(ctx, native, suite.liquidity_token).await?;
    fund(ctx, native, suite.pair).await?;
    fund(ctx, native, suite.handler).await?;
    fund(ctx, native, suite.driver).await?;
    fund(ctx, native, suite.router).await?;

    // Bring up the whole suite in a single transaction.
    factory.call(ctx, "create_pair", &(t0, t1)).await?;

    Ok(Swap {
        token0,
        token1,
        lp: erc20(suite.liquidity_token),
        pair: Contract::new(suite.pair, PAIR.0, PAIR.1),
        handler: Contract::new(suite.handler, HANDLER.0, HANDLER.1),
        driver: Contract::new(suite.driver, DRIVER.0, DRIVER.1),
        router: Contract::new(suite.router, ROUTER.0, ROUTER.1),
    })
}

/// As admin, prime the pool: transfer both tokens to the pair, then mint LP to
/// ourselves, establishing the initial price the providers add against.
async fn prime_pool(ctx: &mut AgentContext, s: &Swap) -> Result<()> {
    let me = ctx.address();
    s.token0
        .call(ctx, "transfer", &(s.pair.address(), SUPPLY))
        .await?;
    s.token1
        .call(ctx, "transfer", &(s.pair.address(), SUPPLY))
        .await?;
    s.pair.call(ctx, "mint_lp", &me).await?;

    let lp_balance: Amount = s.lp.view(ctx, "get_balance_of", &me, None).await?;
    assert!(lp_balance > 0, "priming should mint a positive LP balance");
    println!("primed pool; admin LP balance = {lp_balance}");
    Ok(())
}

/// A liquidity-provider agent:
///
/// * Greets the admin (so it can be airdropped tokens)
/// * Receives the contract addresses
/// * Approves the request handler
/// * Submits an `add_liquidity` request through the router
/// * Once the admin signals the queue is driven, confirms it was minted LP
///
fn liquidity_provider(name: &str) -> Agent {
    Agent::new(name, |mut ctx| async move {
        let me = ctx.address();

        // Announce ourselves so the admin can mint us A/B tokens and send the
        // contract addresses we need.
        ctx.send("admin", &me)?;

        // Receive configuration from the admin.
        let cfg = ctx
            .recv_from::<LPConfig>("admin")
            .await
            .expect("bug: admin closed before sending addresses")?
            .body;
        let token0 = erc20(cfg.token0);
        let token1 = erc20(cfg.token1);
        let router = Contract::new(cfg.router, ROUTER.0, ROUTER.1);
        let lp = erc20(cfg.lp);

        // Allow the request handler to pull our A/B tokens when the request runs.
        let allowance = i128::try_from(USER_LIQUIDITY).expect("bug: allowance fits i128");
        token0
            .call(&mut ctx, "adjust_allowance", &(cfg.handler, allowance))
            .await?;
        token1
            .call(&mut ctx, "adjust_allowance", &(cfg.handler, allowance))
            .await?;

        // Submit an add-liquidity request (executed later, by the driver). LP
        // is minted to us; we tolerate any ratio (amounts_min = [0, 0]).
        let desired: [Amount; 2] = [USER_LIQUIDITY, USER_LIQUIDITY];
        let min: [Amount; 2] = [0, 0];
        router
            .call(
                &mut ctx,
                "add_liquidity",
                &(cfg.token0, cfg.token1, desired, min, me),
            )
            .await?;

        // Tell the admin our request is queued, then wait for it to be driven.
        ctx.send("admin", &())?;
        ctx.recv_from::<()>("admin")
            .await
            .expect("bug: admin closed before driving requests")?;

        let lp_balance: Amount = lp.view(&ctx, "get_balance_of", &me, None).await?;
        assert!(
            lp_balance > 0,
            "add_liquidity should mint LP to the provider"
        );
        println!("{}: received {lp_balance} LP", ctx.name());
        Ok(())
    })
}

/// The admin agent:
/// * Sets up the suite
/// * Operates the request queue for the providers
fn admin() -> Agent {
    Agent::new("admin", |mut ctx| async move {
        let native = native_token();
        let s = deploy_and_init(&mut ctx, &native).await?;
        prime_pool(&mut ctx, &s).await?;

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
            s.token0
                .call(&mut ctx, "mint", &(*addr, USER_LIQUIDITY))
                .await?;
            s.token1
                .call(&mut ctx, "mint", &(*addr, USER_LIQUIDITY))
                .await?;
            ctx.send(name, &config)?;
        }

        // Wait for both providers to signal their requests are queued.
        for _ in 0..PROVIDERS.len() {
            ctx.recv_from_any::<()>(&PROVIDERS)
                .await
                .expect("bug: a provider closed before submitting")?;
        }

        // Drive the queue: both add-liquidity requests should process cleanly.
        let (processed, failed): (u32, u32) = s
            .driver
            .call_returning(&mut ctx, "process_requests", &())
            .await?;
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

#[tokio::test]
#[ignore = "needs GROUNDHOG_DEVNODE_BINARY and built swap fixtures in GROUNDHOG_TESTKIT_ARTIFACT_ROOT"]
async fn swap_liquidity_multi_agent() {
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!(
            "skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT to a directory with the built \
             erc20/swap/swap_request/swap_driver/swap_router/swap_factory artifacts (see module docs)"
        );
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    // The admin funds every contract it deploys (see CONTRACT_FUNDING), so give
    // its dev account plenty of native tokens to distribute.
    config.dev_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }
    if let Ok(protocol) = std::env::var("HOGD_PROTOCOL_OVERRIDE") {
        config.hogd_protocol = Some(protocol);
    }
    if std::env::var("RUST_LOG").is_ok() {
        config.log_level = Some(groundhog_testkit::LogLevel::Trace);
    }

    let scenario = Scenario::builder("swap-sim")
        .network(NetworkConfig::local(config))
        .artifact("erc20", artifact("erc20.rv32a"))
        .artifact("swap_pair", artifact("swap_pair.wasm")) // can't currently build swap as rv32a
        .artifact("swap_request", artifact("swap_request.rv32a"))
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
