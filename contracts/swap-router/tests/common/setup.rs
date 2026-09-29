use super::*;
use sdk::precompiles::ADDRESS_PRECOMPILED_HOG_TOKEN;
use std::env;
use swap_factory::{POOL_FUNDING, SwapFactoryClient, SwapHashes};

pub fn setup_etx() -> Result<Etx> {
    #[cfg(not(feature = "guest_test"))]
    {
        setup_etx_native()
    }

    #[cfg(feature = "guest_test")]
    {
        setup_etx_guest()
    }
}

pub fn setup_etx_native() -> Result<Etx> {
    let env = sdk::TestEnvironment::new(None); // use default cost model

    // Register the contracts the factory deploys, plus the factory and the single suite-wide router
    // (both deployed directly).
    let hashes = SwapHashes {
        token: *erc20::register_mock_contract(&env).as_hash(),
        handler: *swap_handler::register_mock_contract(&env).as_hash(),
        driver: *swap_driver::register_mock_contract(&env).as_hash(),
    };
    let factory_hash = *swap_factory::register_mock_contract(&env).as_hash();
    let router_hash = *swap_router::register_mock_contract(&env).as_hash();

    setup_contracts(&env, hashes, factory_hash, router_hash)
}

#[cfg(feature = "guest_test")]
pub fn setup_etx_guest() -> Result<Etx> {
    let guest_path =
        |name: &str, arch: &str| -> String { format!("../../target/groundhog/{name}.{arch}") };
    let load = |name: &str| load_rv32_contract(guest_path(name, "rv32a"));

    let token_contract = load("erc20");
    let handler_contract = load("swap_handler");
    let driver_contract = load("swap_driver");
    let router_contract = load("swap_router");
    let factory_contract = load("swap_factory");

    let env = sdk::TestEnvironment::new(None); // use default cost model

    let hashes = SwapHashes {
        token: env.setup_create_contract(&token_contract),
        handler: env.setup_create_contract(&handler_contract),
        driver: env.setup_create_contract(&driver_contract),
    };
    let factory_hash = env.setup_create_contract(&factory_contract);
    let router_hash = env.setup_create_contract(&router_contract);

    setup_contracts(&env, hashes, factory_hash, router_hash)
}

// Storage tokens granted to each contract under the default cost model, well above what the swap
// flow spends.
const CONTRACT_FUNDING: i64 = 1_000_000_000;

// Deploy nonces, at module scope so a contract's deterministic address can be computed (and funded)
// before it is actually deployed.
hash_ident! { static TOKEN_0_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_1_NONCE: SHA256Hash; }
hash_ident! { static FACTORY_NONCE: SHA256Hash; }
hash_ident! { static ROUTER_NONCE: SHA256Hash; }

// Under the default cost model, a contract must pay for the storage it writes. Grant storage tokens
// to the (deterministic) address `TEST_ADDR` will deploy `hash` to with `nonce`, so the freshly
// deployed contract is solvent.
fn fund_deploy_target(env: &TestEnvironmentHandle, nonce: &SHA256Hash, hash: &SHA256Hash) {
    let addr = exec_tx(env, &TEST_ADDR, || get_deploy_address(nonce, hash))
        .expect("compute deploy address");
    env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
}

// Build the whole pool through the factory: deploy the A/B tokens, then have a freshly deployed
// factory create the pair, LP token, request handler, driver, and router in a single transaction.
#[rustfmt::skip]
pub fn setup_contracts(
    env: &TestEnvironmentHandle,
    hashes: SwapHashes,
    factory_hash: SHA256Hash,
    router_hash: SHA256Hash,
) -> Result<Etx> {

    // The native HOG token is a precompile: it is live at its address from genesis and cannot be
    // redeployed. Like any other contract, it pays for the allowance ledger it keeps in its own
    // storage.
    env.setup_grant_storage_tokens(&ADDRESS_PRECOMPILED_HOG_TOKEN, CONTRACT_FUNDING);

    // Under the default cost model each contract pays for the storage it writes, so pre-fund
    // everything before it is deployed: the test-user addresses, and each directly-deployed
    // contract.
    env.setup_grant_storage_tokens(&TEST_ADDR, CONTRACT_FUNDING);
    for u in USERS {
        env.setup_grant_storage_tokens(u.addr, CONTRACT_FUNDING);
    }
    fund_deploy_target(env, &TOKEN_0_NONCE, &hashes.token);
    fund_deploy_target(env, &TOKEN_1_NONCE, &hashes.token);
    fund_deploy_target(env, &FACTORY_NONCE, &factory_hash);
    fund_deploy_target(env, &ROUTER_NONCE, &router_hash);

    // Deploy and init the A/B token contracts
    let deployed = exec_tx(env, &TEST_ADDR,
        || ab_tokens_deploy_init(&hashes.token))?;

    /* ----- */ env.advance_block(); /* ----- */

    // Seed our users with A/B tokens
    exec_tx(env, &TEST_ADDR, || airdrop_tokens(&deployed))?;

    /* ----- */ env.advance_block(); /* ----- */

    // Canonical token ordering -- the factory sorts the pair internally, so we track the tokens in
    // the same order for `token0()`/`token1()` to line up with the pair's reserve0/reserve1.
    let token_addrs = sorted(deployed);

    // Each driver the factory creates takes requests from the router alone, so the factory has to
    // be told the router's address -- deterministic, and so knowable before the router is deployed
    // just below.
    let router_addr_predicted =
        exec_tx(env, &TEST_ADDR, move || get_deploy_address(&ROUTER_NONCE, &router_hash))?;

    // Deploy and initialize the factory (protocol fee disabled).
    let factory_addr = exec_tx(env, &TEST_ADDR, move || {
        let factory_addr = deploy_contract(&FACTORY_NONCE, &factory_hash);
        SwapFactoryClient::new(&factory_addr).initialize(hashes, None, &router_addr_predicted);
        factory_addr
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // Deploy the single, suite-wide router, pointed at the factory.
    let router_addr = exec_tx(env, &TEST_ADDR, move || {
        let router_addr = deploy_contract(&ROUTER_NONCE, &router_hash);
        SwapRouterClient::new(&router_addr).initialize(&factory_addr);
        router_addr
    })?;
    assert_eq!(
        router_addr, router_addr_predicted,
        "the router must land at the address the factory was told"
    );

    /* ----- */ env.advance_block(); /* ----- */

    // The factory funds this pair's contracts (LP token, handler, driver) as it deploys them, on
    // the allowance it is granted here.
    exec_tx(env, &TEST_ADDR, move || {
        ERC20Client::new(&ADDRESS_PRECOMPILED_HOG_TOKEN)
            .adjust_allowance(&factory_addr, 3 * POOL_FUNDING.recommended as i128, false);
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // Create this pair's contracts via the factory.
    let pool = exec_tx(env, &TEST_ADDR, move || {
        SwapFactoryClient::new(&factory_addr).create_pair(
            &token_addrs[0],
            &token_addrs[1],
            POOL_FUNDING.recommended,
        )
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    let env = env.clone();
    let ctx = Ctx {
        router_addr,
        driver_addr: pool.driver,
        request_handler_addr: pool.handler,
        liquidity_token: pool.liquidity_token,
        token_addrs,
    };

    Ok(Etx { env, ctx })
}

#[rustfmt::skip]
pub fn setup_etx_primed() -> Result<Etx> {
    let etx = setup_etx()?;

    // Primer buys liquidity tokens, establishing a stable price
    let ctx = etx.ctx;
    let minted = etx.exec_depositing_as_pair(
        PRIMER,
        |u| ctx.user_buy_unpriced(u),
        |pair| pair.mint_lp(PRIMER.addr),
    )?;
    println!("> {} bought {:.3} LP", PRIMER.name, decimalized(minted));

    /* ----- */ etx.advance_block(); /* ----- */

    Ok(etx)
}

// The two token addresses in canonical (ascending) order, matching the factory's own sort.
fn sorted(tokens: Addresses) -> Addresses {
    if tokens[0] <= tokens[1] {
        tokens
    } else {
        [tokens[1], tokens[0]]
    }
}

// Deploy and init A/B token contracts, given the hash of a registered token contract.
fn ab_tokens_deploy_init(token_hash: &SHA256Hash) -> Addresses {
    assert_eq!(&get_current_address(), &TEST_ADDR);

    // Deploy contracts for two tokens that we'd like to swap between
    let token0_addr = deploy_contract(&TOKEN_0_NONCE, token_hash);
    let token1_addr = deploy_contract(&TOKEN_1_NONCE, token_hash);

    let token0 = ERC20MetadataClient::new(&token0_addr);
    let token1 = ERC20MetadataClient::new(&token1_addr);

    // Initialize the token contracts, putting them under control of the test
    token0.initialize(
        TEST.addr,
        None,
        Some(Symbol::try_from("AAA").unwrap()),
        None,
    );
    token1.initialize(
        TEST.addr,
        None,
        Some(Symbol::try_from("BBB").unwrap()),
        None,
    );

    [token0_addr, token1_addr]
}

fn airdrop_tokens(token_addrs: &Addresses) {
    let token0 = ERC20Client::new(&token_addrs[0]);
    let token1 = ERC20Client::new(&token_addrs[1]);

    assert_eq!(token0.get_balance_of(ALICE.addr), 0);
    assert_eq!(token1.get_balance_of(ALICE.addr), 0);

    // Initial airdrops
    for u in USERS {
        token0.mint(u.addr, u.init.0);
        token1.mint(u.addr, u.init.1);
    }
}
