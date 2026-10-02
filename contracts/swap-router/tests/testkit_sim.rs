//! Testkit-driven simulation of the swap contracts.
//!
//! Unlike the native `test_transaction!` tests (which run against the SDK's in-process executor),
//! this drives the real contracts on a live local `hog-devnode` using `groundhog-testkit`.
//!
//! An `admin` agent deploys the factory and router, has the factory create the pool -- funding,
//! deploying and initializing its three contracts in one transaction out of the admin's own HOG --
//! and then primes it with an `add_liquidity` through the router. The admin also acts as the
//! request-queue operator. Two independent liquidity providers (`alice`, `bob`) each run as their
//! own agent: they learn the contract addresses over the harness mailbox, approve the request
//! handler, submit an `add_liquidity` request through the router, and — once the admin has driven
//! the queue — confirm they were minted LP.
//!
//! It is `#[ignore]`d because it needs a devnode binary and built artifacts.
//! `scripts/run-swap-sim.sh` wires up both. Roughly:
//!
//! ```text
//! cd groundhog-examples
//! for c in erc20 swap-handler swap-driver swap-router swap-factory; do groundhog build -p "$c"; done
//! RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info" \
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/path/to/target/groundhog \
//!     cargo test -p swap-router --test testkit_sim -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use groundhog_erc20_if::Amount;
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{
    Agent, AgentContext, Contract, DeployOptions, LocalNetworkConfig, NetworkConfig, Result,
    Scenario, xdrs,
};
use swap_factory::POOL_FUNDING;
use swap_if::{Pool, SwapHashes};

/// An alias to match the contracts' `Address` type.
type Address = ContractAddress;

// Interface identities (name, version) the contracts stamped at build time, as recorded in each
// `*.spec.json`. `entrypoint_id` derives selectors from these.
const ERC20: (&str, &str) = ("ERC20", "0.1.44");
const HANDLER: (&str, &str) = ("SwapHandler", "0.1.0");
const DRIVER: (&str, &str) = ("SwapDriver", "0.1.0");
const ROUTER: (&str, &str) = ("SwapRouter", "0.1.0");
const FACTORY: (&str, &str) = ("SwapFactory", "0.1.0");

/// The liquidity providers, each run as its own agent.
const PROVIDERS: [&str; 2] = ["alice", "bob"];

/// Amount the admin mints itself per token, then supplies to prime the pool.
const SUPPLY: Amount = 1_000_000_000;

/// Amount of each token the admin airdrops to a provider, which the provider then contributes as
/// liquidity. Small relative to `SUPPLY` so the priced pool absorbs it at roughly the established
/// 1:1 ratio.
const USER_LIQUIDITY: Amount = 1_000_000;

/// Native (HOG) storage tokens the admin grants each contract it deploys.
///
/// A contract must pay native tokens for the storage it creates. Funding each contract up front —
/// far above the few hundred thousand tokens a typical write costs — keeps the swap flow solvent.
const CONTRACT_FUNDING: Amount = 1_000_000_000;

/// The contract suite
struct Swap {
    token0: Contract,
    token1: Contract,
    lp: Contract,
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
/// It lives at the genesis precompile address `0x00…01` and speaks the ERC20 interface, vendored at
/// `groundhog-erc20-if` 0.1.3.
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
// `xdrs` reaches us re-exported through the testkit, not as a direct crate, so point the derives'
// generated code at that path.
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

/// As admin
/// - register the suite's code
/// - deploy two tokens, the factory and the router
/// - initialize both
/// - have the factory create the pool, funding it out of our own HOG
async fn deploy_and_init(
    ctx: &mut AgentContext,
    native: &Contract,
    fee_to: Option<Address>,
) -> Result<Swap> {
    let me = ctx.address();

    // Register the code the factory will deploy by hash. (erc20 registers when we deploy the tokens
    // below; the rest we register explicitly, since the factory -- not us -- deploys their
    // instances. The router is deployed directly below, so it needs no registration by hash.)

    // The native token pays for its own storage, so it needs funds in order to
    // store balances and allowance records.
    fund(ctx, native, native.address()).await?;

    ctx.register_artifact("swap_handler", DeployOptions::funded(0))
        .await?;
    ctx.register_artifact("swap_driver", DeployOptions::funded(0))
        .await?;

    // The two A/B token contracts (owned by us). Each is funded right after deploy so it can pay
    // for the storage its state writes create.
    let token0 = erc20(
        ctx.deploy_artifact("erc20", DeployOptions::funded(0))
            .await?
            .address,
    );
    fund(ctx, native, token0.address()).await?;
    let token1 = erc20(
        ctx.deploy_artifact("erc20", DeployOptions::funded(0))
            .await?
            .address,
    );
    fund(ctx, native, token1.address()).await?;
    token0.call(ctx, "initialize", &me).await?;
    token1.call(ctx, "initialize", &me).await?;

    // Mint ourselves a supply of each token, used below to prime the pool.
    token0.call(ctx, "mint", &(me, SUPPLY)).await?;
    token1.call(ctx, "mint", &(me, SUPPLY)).await?;

    // Deploy and fund the factory and the router. Each driver the factory creates takes requests
    // from the router alone, so the factory has to be told the router's address -- which means
    // deploying the router first, and initializing it second.
    let factory = Contract::new(
        ctx.deploy_artifact("swap_factory", DeployOptions::funded(0))
            .await?
            .address,
        FACTORY.0,
        FACTORY.1,
    );
    fund(ctx, native, factory.address()).await?;
    let router = Contract::new(
        ctx.deploy_artifact("swap_router", DeployOptions::funded(0))
            .await?
            .address,
        ROUTER.0,
        ROUTER.1,
    );
    fund(ctx, native, router.address()).await?;

    let hashes = SwapHashes {
        token: ctx.contract_hash("erc20")?,
        handler: ctx.contract_hash("swap_handler")?,
        driver: ctx.contract_hash("swap_driver")?,
    };
    factory
        .call(ctx, "initialize", &(hashes, fee_to, router.address()))
        .await?;
    router.call(ctx, "initialize", &factory.address()).await?;

    // Create the pool. The factory funds its three contracts as it deploys them, out of *our* HOG,
    // so it needs an allowance covering all three -- and that one transaction leaves them deployed,
    // solvent and initialized.
    let (t0, t1) = (token0.address(), token1.address());
    native
        .call(
            ctx,
            "adjust_allowance",
            &(factory.address(), 3 * POOL_FUNDING.recommended),
        )
        .await?;
    factory
        .call(ctx, "create_pair", &(t0, t1, POOL_FUNDING.recommended))
        .await?;

    // `create_pair` returns the pool, but a call yields a receipt rather than a decoded value; the
    // same addresses come back from `pool_addresses`, which is deterministic in the token pair and
    // so answers for a pool that exists just as well as for one that does not.
    let pool: Pool = factory.view(ctx, "pool_addresses", &(t0, t1), None).await?;

    Ok(Swap {
        token0,
        token1,
        lp: erc20(pool.liquidity_token),
        handler: Contract::new(pool.handler, HANDLER.0, HANDLER.1),
        driver: Contract::new(pool.driver, DRIVER.0, DRIVER.1),
        router,
    })
}

/// As admin, prime the pool through the router, establishing the initial price the providers add
/// against.
///
/// The pool already exists: the router never creates one, so `deploy_and_init` had the factory
/// create it. This is the first liquidity in it.
async fn prime_pool(ctx: &mut AgentContext, s: &Swap) -> Result<()> {
    let me = ctx.address();

    // Let the request handler pull our tokens when the request is executed.
    let supply = SUPPLY;
    s.token0
        .call(ctx, "adjust_allowance", &(s.handler.address(), supply))
        .await?;
    s.token1
        .call(ctx, "adjust_allowance", &(s.handler.address(), supply))
        .await?;

    // Route an add-liquidity request. The pair doesn't exist, so this creates it, then enqueues the
    // request with its (newly created) driver.
    let desired: [Amount; 2] = [SUPPLY, SUPPLY];
    let min: [Amount; 2] = [0, 0];
    s.router
        .call(
            ctx,
            "add_liquidity",
            &(s.token0.address(), s.token1.address(), desired, min, me),
        )
        .await?;

    // Drive the queue to execute the (pair-creating) request.
    let (processed, failed): (u32, u32) = s
        .driver
        .call_returning(ctx, "process_requests", &())
        .await?;
    assert_eq!(
        (processed, failed),
        (1, 0),
        "the priming add_liquidity should process without failure"
    );

    let lp_balance: Amount = s.lp.view(ctx, "get_balance_of", &me, None).await?;
    assert!(lp_balance > 0, "priming should mint a positive LP balance");
    println!("primed pool via router-created pair; admin LP balance = {lp_balance}");
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

        // Announce ourselves so the admin can mint us A/B tokens and send the contract addresses we
        // need.
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
        let allowance = USER_LIQUIDITY;
        token0
            .call(&mut ctx, "adjust_allowance", &(cfg.handler, allowance))
            .await?;
        token1
            .call(&mut ctx, "adjust_allowance", &(cfg.handler, allowance))
            .await?;

        // Submit an add-liquidity request (executed later, by the driver). LP is minted to us; we
        // tolerate any ratio (amounts_min = [0, 0]).
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
        let s = deploy_and_init(&mut ctx, &native, None).await?;
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
             erc20/swap/swap_handler/swap_driver/swap_router/swap_factory artifacts (see module docs)"
        );
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    // The admin funds every contract it deploys (see CONTRACT_FUNDING), so give its dev account
    // plenty of native tokens to distribute.
    config.dev_account_tokens = 100_000_000_000;
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

/////////////////////// gas calibration /////////////////////////////////////

#[cfg(feature = "calibration")]
use batch_driver::GasReport;

/// Read the `GasReport` a `calibration` build's crank emits, from the receipt
/// of the transaction that cranked.
#[cfg(feature = "calibration")]
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
#[cfg(feature = "calibration")]
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
        let add_i = i128::try_from(add).unwrap();
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
        s.lp.call(
            &mut ctx,
            "adjust_allowance",
            &(s.handler.address(), i128::try_from(redeem).unwrap()),
        )
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
#[cfg(feature = "calibration")]
async fn swap_a_little(ctx: &mut AgentContext, s: &Swap, me: Address) -> Result<()> {
    let amount_in: Amount = SUPPLY / 1_000;
    s.token0
        .call(
            ctx,
            "adjust_allowance",
            &(s.handler.address(), i128::try_from(amount_in).unwrap()),
        )
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
#[cfg(feature = "calibration")]
async fn swap_a_little_exact_out(ctx: &mut AgentContext, s: &Swap, me: Address) -> Result<()> {
    let amount_out: Amount = SUPPLY / 1_000;
    // The handler pulls whatever the curve says the output costs, which it
    // learns only at execution; the allowance has to cover the cap we set.
    let amount_in_max: Amount = SUPPLY / 100;
    s.token0
        .call(
            ctx,
            "adjust_allowance",
            &(s.handler.address(), i128::try_from(amount_in_max).unwrap()),
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

#[cfg(feature = "calibration")]
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

#[cfg(feature = "calibration")]
#[tokio::test]
#[ignore = "needs GROUNDHOG_DEVNODE_BINARY and calibration-built swap fixtures"]
async fn calibrate_crank_gas() {
    // Twice, because the pair's `mint_fee` only does real work when a protocol
    // fee is configured -- a square root and some U256 arithmetic on every
    // liquidity event -- and the liquidity budgets have to cover that too.
    for fee_enabled in [false, true] {
        run_calibration(fee_enabled).await;
    }
}

#[cfg(feature = "calibration")]
async fn run_calibration(fee_enabled: bool) {
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    config.dev_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }

    let scenario = Scenario::builder("swap-gas-calibration")
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
        .run_agents([calibrator(fee_enabled)])
        .await
        .expect("calibration runs to completion");
}
