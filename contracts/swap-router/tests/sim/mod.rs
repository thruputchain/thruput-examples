#![allow(unused)]

use groundhog_erc20_if::Amount;
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{AgentContext, Contract, DeployOptions, Result, xdrs};
use swap_factory::POOL_FUNDING;
use swap_if::{Pool, SwapHashes};

// An alias to match the contracts' `Address` type.
type Address = ContractAddress;

// Interface identities (name, version)
pub const ERC20: (&str, &str) = ("ERC20", "0.1.51");
pub const HANDLER: (&str, &str) = ("SwapHandler", "0.1.0");
pub const DRIVER: (&str, &str) = ("SwapDriver", "0.1.0");
pub const ROUTER: (&str, &str) = ("SwapRouter", "0.1.0");
pub const FACTORY: (&str, &str) = ("SwapFactory", "0.1.0");

// Names for the two liquidity-provider agents
pub const PROVIDERS: [&str; 2] = ["alice", "bob"];

// Amount the admin mints itself per token, then supplies to prime the pool.
pub const SUPPLY: Amount = 1_000_000_000;

// Amount of each token the admin airdrops to a provider, which the provider
// then contributes as liquidity. Small relative to `SUPPLY` so the priced pool
// absorbs it at roughly the established 1:1 ratio.
pub const USER_LIQUIDITY: Amount = 1_000_000;

// Native storage tokens the admin grants each contract it deploys.
//
// A contract must pay native tokens for the storage it creates. Funding each
// contract up front, far above the few hundred thousand tokens a typical write
// costs, keeps the swap flow solvent.
pub const CONTRACT_FUNDING: Amount = 1_000_000_000;

// The contract suite
pub struct Swap {
    pub token0: Contract,
    pub token1: Contract,
    pub lp: Contract,
    pub handler: Contract,
    pub driver: Contract,
    pub router: Contract,
}

// An ERC20 contract for token0, token1, and lp
pub fn erc20(address: Address) -> Contract {
    Contract::new(address, ERC20.0, ERC20.1)
}

// The native-token contract.
//
// It lives at the genesis precompile address and speaks the ERC20 interface, vendored at
// `groundhog-erc20-if` 0.1.3.
pub fn native_token() -> Contract {
    Contract::new(
        sdk::precompiles::ADDRESS_PRECOMPILED_HOG_TOKEN,
        "ERC20",
        "0.1.3",
    )
}

// Grant `target` enough native tokens to pay for the storage it will create.
async fn fund(ctx: &mut AgentContext, native: &Contract, target: Address) -> Result<()> {
    native
        .call(ctx, "transfer", &(target, CONTRACT_FUNDING))
        .await?;
    Ok(())
}

// The contract addresses a provider needs, sent to it over the mailbox.
#[derive(Debug, Clone, xdrs::WriteXDR, xdrs::ReadXDR)]
// `xdrs` reaches us re-exported through the testkit, not as a direct crate, so point the derives'
// generated code at that path.
#[xdr(crate = "groundhog_testkit::xdrs")]
pub struct LPConfig {
    pub token0: Address,
    pub token1: Address,
    pub handler: Address,
    pub router: Address,
    pub lp: Address,
}

impl LPConfig {
    pub fn of(s: &Swap) -> Self {
        Self {
            token0: s.token0.address(),
            token1: s.token1.address(),
            handler: s.handler.address(),
            router: s.router.address(),
            lp: s.lp.address(),
        }
    }
}

// As admin:
// - register the suite's code
// - deploy two tokens, the factory, and the router
// - initialize both
// - have the factory create the pool with our own funds
pub async fn deploy_and_init(
    ctx: &mut AgentContext,
    native: &Contract,
    fee_to: Option<Address>,
) -> Result<Swap> {
    let me = ctx.address();

    // Register the code the factory will deploy by hash. (erc20 registers when
    // we deploy the tokens below; the rest we register explicitly, since the
    // factory deploys their instances. The router is deployed directly below,
    // so it needs no registration by hash.)

    // The native token pays for its own storage, so it needs funds in order to
    // store balances and allowance records.
    fund(ctx, native, native.address()).await?;

    ctx.register_artifact(
        "swap_handler",
        DeployOptions::funded(CONTRACT_FUNDING as u128),
    )
    .await?;
    ctx.register_artifact(
        "swap_driver",
        DeployOptions::funded(CONTRACT_FUNDING as u128),
    )
    .await?;

    // The two A/B token contracts (owned by us). Each is funded at deploy so it
    // can pay for the storage its state writes create.
    let token0 = erc20(
        ctx.deploy_artifact("erc20", DeployOptions::funded(CONTRACT_FUNDING as u128))
            .await?
            .address,
    );
    let token1 = erc20(
        ctx.deploy_artifact("erc20", DeployOptions::funded(CONTRACT_FUNDING as u128))
            .await?
            .address,
    );
    token0.call(ctx, "initialize", &me).await?;
    token1.call(ctx, "initialize", &me).await?;

    // Mint ourselves a supply of each token, used below to prime the pool.
    token0.call(ctx, "mint", &(me, SUPPLY)).await?;
    token1.call(ctx, "mint", &(me, SUPPLY)).await?;

    // Deploy and fund the factory and the router.
    let factory = Contract::new(
        ctx.deploy_artifact(
            "swap_factory",
            DeployOptions::funded(CONTRACT_FUNDING as u128),
        )
        .await?
        .address,
        FACTORY.0,
        FACTORY.1,
    );
    let router = Contract::new(
        ctx.deploy_artifact(
            "swap_router",
            DeployOptions::funded(CONTRACT_FUNDING as u128),
        )
        .await?
        .address,
        ROUTER.0,
        ROUTER.1,
    );
    let hashes = SwapHashes {
        token: ctx.contract_hash("erc20")?,
        handler: ctx.contract_hash("swap_handler")?,
        driver: ctx.contract_hash("swap_driver")?,
    };
    factory
        .call(ctx, "initialize", &(hashes, fee_to, router.address()))
        .await?;
    router.call(ctx, "initialize", &factory.address()).await?;

    // Create the pool. The factory funds its three contracts as it deploys
    // them, so we give it an allowance covering all three.
    let (t0, t1) = (token0.address(), token1.address());
    native
        .call(
            ctx,
            "adjust_allowance",
            &(factory.address(), 3 * POOL_FUNDING.recommended),
        )
        .await?;
    let pool: Pool = factory
        .call_returning(ctx, "create_pair", &(t0, t1, POOL_FUNDING.recommended))
        .await?;

    // We should get the same metadata this way:
    assert_eq!(
        pool,
        factory.view(ctx, "pool_addresses", &(t0, t1), None).await?
    );

    // Complete the suite of contracts from the addresses we got back from the
    // factory
    let lp = erc20(pool.liquidity_token);
    let handler = Contract::new(pool.handler, HANDLER.0, HANDLER.1);
    let driver = Contract::new(pool.driver, DRIVER.0, DRIVER.1);

    Ok(Swap {
        token0,
        token1,
        lp,
        handler,
        driver,
        router,
    })
}

// As admin, prime the pool through the router, establishing the initial price.
pub async fn prime_pool(ctx: &mut AgentContext, s: &Swap) -> Result<()> {
    let me = ctx.address();

    // Let the request handler pull our tokens when the request is executed.
    s.token0
        .call(ctx, "adjust_allowance", &(s.handler.address(), SUPPLY))
        .await?;
    s.token1
        .call(ctx, "adjust_allowance", &(s.handler.address(), SUPPLY))
        .await?;

    let desired: [Amount; 2] = [SUPPLY, SUPPLY];
    let min: [Amount; 2] = [0, 0];
    s.router
        .call(
            ctx,
            "add_liquidity",
            &(s.token0.address(), s.token1.address(), desired, min, me),
        )
        .await?;

    // Drive the queue to execute the `add_liquidity` request.
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
    println!("primed pool; admin LP balance = {lp_balance}");
    Ok(())
}
