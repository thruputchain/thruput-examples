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
//! for c in erc20 swap_request swap_driver swap_router; do groundhog build -p "$c"; done
//! groundhog build -p swap --target wasm   # swap does not build for rv32a yet
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/path/to/target/groundhog \
//!     cargo test -p swap_router --test testkit_sim -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use groundhog_erc20_if::Amount;
use groundhog_testkit::rpc_types::receipt::{ExecStatus, TransactionReceipt};
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{
    Agent, AgentContext, Contract, LocalTargetConfig, Result, Scenario, TargetConfig, xdrs,
};

/// An alias to match the contracts' `Address` type.
type Address = ContractAddress;

// Interface identities (name, version) the contracts stamped at build time, as
// recorded in each `*.spec.json`. `entrypoint_id` derives selectors from
// these.
const ERC20: (&str, &str) = ("ERC20", "0.1.5");
const PAIR: (&str, &str) = ("ISwapV2Pair", "0.1.0");
const HANDLER: (&str, &str) = ("ISwapRequestHandler", "0.1.0");
const DRIVER: (&str, &str) = ("SwapV2Driver", "0.1.0");
const ROUTER: (&str, &str) = ("Router", "0.1.0");

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

/// The five contract addresses a provider needs, sent over the mailbox.
type Bundle = (Address, Address, Address, Address, Address);

fn encode_bundle(s: &Swap) -> Vec<u8> {
    xdrs::cxs::encode(&(
        s.token0.address(),
        s.token1.address(),
        s.handler.address(),
        s.router.address(),
        s.lp.address(),
    ))
    .expect("bug: address bundle encodes")
}

fn decode_bundle(bytes: &[u8]) -> Bundle {
    xdrs::cxs::decode(bytes).expect("bug: address bundle decodes")
}

fn encode_addr(addr: Address) -> Vec<u8> {
    xdrs::cxs::encode(&addr).expect("bug: address encodes")
}

fn decode_addr(bytes: &[u8]) -> Address {
    xdrs::cxs::decode(bytes).expect("bug: address decodes")
}

/// As admin: deploy, fund, and initialize the contract suite.
async fn deploy_and_init(ctx: &mut AgentContext, native: &Contract) -> Result<Swap> {
    let me = ctx.address();

    // The two A/B token contracts (owned by us).
    //
    // Each contract is funded right after deploy so it can pay for the storage
    // its state writes create.
    let token0 = erc20(ctx.deploy_artifact("erc20").await?.address);
    fund(ctx, native, token0.address()).await?;
    let token1 = erc20(ctx.deploy_artifact("erc20").await?.address);
    fund(ctx, native, token1.address()).await?;
    assert_ok(
        &token0.call(ctx, "initialize", &me).await?,
        "token0.initialize",
    );
    assert_ok(
        &token1.call(ctx, "initialize", &me).await?,
        "token1.initialize",
    );

    // Mint ourselves a supply of each token, used below to prime the pool.
    assert_ok(&token0.call(ctx, "mint", &(me, SUPPLY)).await?, "token0.mint");
    assert_ok(&token1.call(ctx, "mint", &(me, SUPPLY)).await?, "token1.mint");

    // Deploy and fund the LP token, then the pair that adopts it.
    let lp = erc20(ctx.deploy_artifact("erc20").await?.address);
    fund(ctx, native, lp.address()).await?;
    let pair = Contract::new(ctx.deploy_artifact("swap").await?.address, PAIR.0, PAIR.1);
    fund(ctx, native, pair.address()).await?;

    // Initialize the pair, which takes a deployed but uninitialized ERC20 and
    // initializes it under the pair's control.
    assert_ok(
        &pair
            .call(
                ctx,
                "initialize",
                &(me, token0.address(), token1.address(), lp.address()),
            )
            .await?,
        "pair.initialize",
    );

    // Request handler, driver, and router: deploy, fund, and init.
    let handler = Contract::new(
        ctx.deploy_artifact("swap_request").await?.address,
        HANDLER.0,
        HANDLER.1,
    );
    fund(ctx, native, handler.address()).await?;
    assert_ok(
        &handler
            .call(
                ctx,
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
    fund(ctx, native, driver.address()).await?;
    assert_ok(
        &driver.call(ctx, "initialize", &handler.address()).await?,
        "driver.initialize",
    );

    let router = Contract::new(
        ctx.deploy_artifact("swap_router").await?.address,
        ROUTER.0,
        ROUTER.1,
    );
    fund(ctx, native, router.address()).await?;
    assert_ok(
        &router
            .call(
                ctx,
                "initialize",
                &(driver.address(), token0.address(), token1.address()),
            )
            .await?,
        "router.initialize",
    );

    Ok(Swap {
        token0,
        token1,
        lp,
        pair,
        handler,
        driver,
        router,
    })
}

/// As admin, prime the pool: transfer both tokens to the pair, then mint LP to
/// ourselves, establishing the initial price the providers add against.
async fn prime_pool(ctx: &mut AgentContext, s: &Swap) -> Result<()> {
    let me = ctx.address();
    assert_ok(
        &s.token0
            .call(ctx, "transfer", &(s.pair.address(), SUPPLY))
            .await?,
        "token0.transfer",
    );
    assert_ok(
        &s.token1
            .call(ctx, "transfer", &(s.pair.address(), SUPPLY))
            .await?,
        "token1.transfer",
    );
    assert_ok(&s.pair.call(ctx, "mint_lp", &me).await?, "pair.mint_lp");

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
        ctx.send_to("admin", encode_addr(me))?;

        // Receive configuration from the admin.
        let msg = ctx
            .recv()
            .await
            .expect("bug: admin closed before sending addresses");
        let (token0_addr, token1_addr, handler_addr, router_addr, lp_addr) =
            decode_bundle(&msg.bytes);
        let token0 = erc20(token0_addr);
        let token1 = erc20(token1_addr);
        let router = Contract::new(router_addr, ROUTER.0, ROUTER.1);
        let lp = erc20(lp_addr);

        // Allow the request handler to pull our A/B tokens when the request runs.
        let allowance = i128::try_from(USER_LIQUIDITY).expect("bug: allowance fits i128");
        assert_ok(
            &token0
                .call(&mut ctx, "adjust_allowance", &(handler_addr, allowance))
                .await?,
            "approve token0",
        );
        assert_ok(
            &token1
                .call(&mut ctx, "adjust_allowance", &(handler_addr, allowance))
                .await?,
            "approve token1",
        );

        // Submit an add-liquidity request (executed later, by the driver). LP
        // is minted to us; we tolerate any ratio (amounts_min = [0, 0]).
        let desired: [Amount; 2] = [USER_LIQUIDITY, USER_LIQUIDITY];
        let min: [Amount; 2] = [0, 0];
        assert_ok(
            &router
                .call(
                    &mut ctx,
                    "add_liquidity",
                    &(token0_addr, token1_addr, desired, min, me),
                )
                .await?,
            "router.add_liquidity",
        );

        // Tell the admin our request is queued, then wait for it to be driven.
        ctx.send_to("admin", b"submitted".to_vec())?;
        ctx.recv()
            .await
            .expect("bug: admin closed before driving requests");

        let lp_balance: Amount = lp.view(&ctx, "get_balance_of", &me, None).await?;
        assert!(lp_balance > 0, "add_liquidity should mint LP to the provider");
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
                .recv()
                .await
                .expect("bug: a provider closed before greeting");
            providers.push((hello.from, decode_addr(&hello.bytes)));
        }

        // Airdrop A/B tokens to each provider, then send the contract addresses.
        let bundle = encode_bundle(&s);
        for (name, addr) in &providers {
            assert_ok(
                &s.token0.call(&mut ctx, "mint", &(*addr, USER_LIQUIDITY)).await?,
                "mint token0 to provider",
            );
            assert_ok(
                &s.token1.call(&mut ctx, "mint", &(*addr, USER_LIQUIDITY)).await?,
                "mint token1 to provider",
            );
            ctx.send_to(name, bundle.clone())?;
        }

        // Wait for both providers to queue their requests.
        for _ in 0..PROVIDERS.len() {
            let ack = ctx
                .recv()
                .await
                .expect("bug: a provider closed before submitting");
            assert_eq!(ack.bytes, b"submitted", "unexpected message from {}", ack.from);
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
            ctx.send_to(name, b"processed".to_vec())?;
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
             erc20/swap/swap_request/swap_driver/swap_router artifacts (see module docs)"
        );
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalTargetConfig::default();
    // The admin funds every contract it deploys (see CONTRACT_FUNDING), so give
    // its dev account plenty of native tokens to distribute.
    config.dev_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }
    if let Ok(protocol) = std::env::var("HOGD_PROTOCOL_OVERRIDE") {
        config.hogd_protocol = Some(protocol);
    }

    let scenario = Scenario::builder("swap-sim")
        .target(TargetConfig::local(config))
        .artifact("erc20", artifact("erc20.rv32a"))
        .artifact("swap", artifact("swap.wasm")) // can't currently build swap as rv32a
        .artifact("swap_request", artifact("swap_request.rv32a"))
        .artifact("swap_driver", artifact("swap_driver.rv32a"))
        .artifact("swap_router", artifact("swap_router.rv32a"))
        .build()
        .await
        .expect("local node starts with the swap artifacts registered");

    let report = scenario
        .run_agents([
            admin(),
            liquidity_provider(PROVIDERS[0]),
            liquidity_provider(PROVIDERS[1]),
        ])
        .await
        .expect("agents run to completion");

    assert!(report.all_ok(), "scenario failed: {report:?}");
    scenario.stop().await.expect("clean teardown");
}
