#![allow(unused)]

use groundhog_erc20_if::{Amount, Difference};
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{AgentContext, Contract, DeployOptions, Result, xdrs};
use swap_factory::POOL_FUNDING;
use swap_if::{Pool, SwapHashes};

// Typed contract clients
mod client;
mod erc20;
mod swap;
pub use erc20::ERC20Client;
pub use swap::{SwapDriverClient, SwapFactoryClient, SwapRouterClient};

// An alias to match the contracts' `Address` type.
type Address = ContractAddress;

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

// The contract suite, bound to the agent that deployed it. (The handler is
// only ever named, never called.)
pub struct Swap {
    pub token0: ERC20Client,
    pub token1: ERC20Client,
    pub lp: ERC20Client,
    pub handler: Address,
    pub driver: SwapDriverClient,
    pub router: SwapRouterClient,
}

// The native-token contract.
//
// It lives at the genesis precompile address and speaks the ERC20 interface, vendored at
// `groundhog-erc20-if` 0.1.3.
pub fn native_token(ctx: &AgentContext) -> ERC20Client {
    ERC20Client::with_contract(
        ctx,
        Contract::new(
            sdk::precompiles::ADDRESS_PRECOMPILED_HOG_TOKEN,
            "ERC20",
            "0.1.3",
        ),
    )
}

// Convert an ERC20 amount to the swap interfaces' unsigned amount.
pub fn swap_amount(amount: Amount) -> swap_if::Amount {
    swap_if::Amount::try_from(amount).expect("bug: negative token amount")
}

// Grant `target` enough native tokens to pay for the storage it will create.
async fn fund(native: &ERC20Client, target: Address) -> Result<()> {
    native.transfer(&target, CONTRACT_FUNDING).await
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
            handler: s.handler,
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
    ctx: &AgentContext,
    native: &ERC20Client,
    fee_to: Option<Address>,
) -> Result<Swap> {
    let me = ctx.address();
    let funded = DeployOptions::funded(CONTRACT_FUNDING as u128);

    // Register the code the factory will deploy by hash. (erc20 registers when
    // we deploy the tokens below; the rest we register explicitly, since the
    // factory deploys their instances. The router is deployed directly below,
    // so it needs no registration by hash.)

    // The native token pays for its own storage, so it needs funds in order to
    // store balances and allowance records.
    fund(native, native.address()).await?;

    ctx.register_artifact("swap_handler", funded).await?;
    ctx.register_artifact("swap_driver", funded).await?;

    // The two A/B token contracts (owned by us). Each is funded at deploy so it
    // can pay for the storage its state writes create.
    let token0 = ERC20Client::new(ctx, ctx.deploy_artifact("erc20", funded).await?.address);
    let token1 = ERC20Client::new(ctx, ctx.deploy_artifact("erc20", funded).await?.address);
    token0.initialize(&me).await?;
    token1.initialize(&me).await?;

    // Mint ourselves a supply of each token, used below to prime the pool.
    token0.mint(&me, SUPPLY).await?;
    token1.mint(&me, SUPPLY).await?;

    // Deploy and fund the factory and the router.
    let factory = SwapFactoryClient::new(
        ctx,
        ctx.deploy_artifact("swap_factory", funded).await?.address,
    );
    let router = SwapRouterClient::new(
        ctx,
        ctx.deploy_artifact("swap_router", funded).await?.address,
    );
    let hashes = SwapHashes {
        token: ctx.contract_hash("erc20")?,
        handler: ctx.contract_hash("swap_handler")?,
        driver: ctx.contract_hash("swap_driver")?,
    };
    factory
        .initialize(hashes, fee_to, &router.address())
        .await?;
    router.initialize(&factory.address()).await?;

    // Create the pool. The factory funds its three contracts as it deploys
    // them, so we give it an allowance covering all three.
    let (t0, t1) = (token0.address(), token1.address());
    let pool_allowance = Difference::try_from(3 * POOL_FUNDING.recommended)
        .expect("bug: pool funding overflows an allowance");
    native
        .adjust_allowance(&factory.address(), pool_allowance)
        .await?;
    let pool = factory
        .create_pair(&t0, &t1, POOL_FUNDING.recommended)
        .await?;

    // We should get the same metadata this way:
    assert_eq!(pool, factory.pool_addresses(&t0, &t1).await?);

    // Complete the suite of contracts from the addresses we got back from the
    // factory
    let lp = ERC20Client::new(ctx, pool.liquidity_token);
    let driver = SwapDriverClient::new(ctx, pool.driver);

    Ok(Swap {
        token0,
        token1,
        lp,
        handler: pool.handler,
        driver,
        router,
    })
}

// As admin, prime the pool through the router, establishing the initial price.
pub async fn prime_pool(ctx: &AgentContext, s: &Swap) -> Result<()> {
    let me = ctx.address();

    // Let the request handler pull our tokens when the request is executed.
    s.token0.adjust_allowance(&s.handler, SUPPLY).await?;
    s.token1.adjust_allowance(&s.handler, SUPPLY).await?;

    let desired = [swap_amount(SUPPLY); 2];
    s.router
        .add_liquidity(
            &s.token0.address(),
            &s.token1.address(),
            desired,
            [0, 0],
            &me,
        )
        .await?;

    // Drive the queue to execute the `add_liquidity` request.
    let (processed, failed) = s.driver.process_requests().await?;
    assert_eq!(
        (processed, failed),
        (1, 0),
        "the priming add_liquidity should process without failure"
    );

    let lp_balance = s.lp.get_balance_of(&me).await?;
    assert!(lp_balance > 0, "priming should mint a positive LP balance");
    println!("primed pool; admin LP balance = {lp_balance}");
    Ok(())
}
