use super::*;
use swap_factory::{SwapFactoryClient, SwapHashes};

pub fn setup_etx() -> Result<Etx> {
    #[cfg(not(feature = "wasm_test"))]
    {
        setup_etx_native()
    }

    #[cfg(feature = "wasm_test")]
    {
        setup_etx_wasm()
    }
}

pub fn setup_etx_native() -> Result<Etx> {
    let env = sdk::TestEnvironment::no_cost();

    // Register the contracts the factory will deploy, plus the factory itself.
    let hashes = SwapHashes {
        token: *erc20::register_mock_contract(&env).as_hash(),
        pair: *swap_pair::register_mock_contract(&env).as_hash(),
        handler: *swap_handler::register_mock_contract(&env).as_hash(),
        driver: *swap_driver::register_mock_contract(&env).as_hash(),
        router: *swap_router::register_mock_contract(&env).as_hash(),
    };
    let factory_hash = *swap_factory::register_mock_contract(&env).as_hash();

    setup_contracts(&env, hashes, factory_hash)
}

pub fn setup_etx_wasm() -> Result<Etx> {
    let load = |name: &str| {
        load_wasm_contract(format!(
            "../target/wasm32-unknown-unknown/release/{name}.wasm"
        ))
    };
    let token_contract = load("erc20");
    let pair_contract = load("swap");
    let handler_contract = load("swap_handler");
    let driver_contract = load("swap_driver");
    let router_contract = load("swap_router");
    let factory_contract = load("swap_factory");

    let env = sdk::TestEnvironment::no_cost();

    let hashes = SwapHashes {
        token: env.setup_create_contract(&token_contract),
        pair: env.setup_create_contract(&pair_contract),
        handler: env.setup_create_contract(&handler_contract),
        driver: env.setup_create_contract(&driver_contract),
        router: env.setup_create_contract(&router_contract),
    };
    let factory_hash = env.setup_create_contract(&factory_contract);

    setup_contracts(&env, hashes, factory_hash)
}

// Build the whole suite through the factory: deploy the A/B tokens, then have
// a freshly deployed factory create the pair, LP token, request handler,
// driver, and router in a single transaction.
#[rustfmt::skip]
pub fn setup_contracts(
    env: &TestEnvironmentHandle,
    hashes: SwapHashes,
    factory_hash: SHA256Hash,
) -> Result<Etx> {

    // Deploy and init the A/B token contracts
    let deployed = exec_tx(env, &TEST_ADDR,
        || ab_tokens_deploy_init(&hashes.token))?;

    /* ----- */ env.advance_block(); /* ----- */

    // Seed our users with A/B tokens
    exec_tx(env, &TEST_ADDR, || airdrop_tokens(&deployed))?;

    /* ----- */ env.advance_block(); /* ----- */

    // Canonical token ordering -- the factory sorts the pair internally, so we
    // track the tokens in the same order for `token0()`/`token1()` to line up
    // with the pair's reserve0/reserve1.
    let token_addrs = sorted(deployed);

    // Deploy the factory and, in one transaction, bring up the entire suite.
    let suite = exec_tx(env, &TEST_ADDR, || {
        hash_ident! { static FACTORY_NONCE: SHA256Hash; }
        let factory_addr = deploy_contract(&FACTORY_NONCE, &factory_hash);
        let factory = SwapFactoryClient::new(&factory_addr);

        // Fee disabled: these tests don't exercise the protocol fee.
        factory.initialize(hashes, None);
        factory.create_pair(&token_addrs[0], &token_addrs[1])
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    let env = env.clone();
    let ctx = Ctx {
        router_addr: suite.router,
        driver_addr: suite.driver,
        request_handler_addr: suite.handler,
        pair_addr: suite.pair,
        liquidity_token: suite.liquidity_token,
        token_addrs,
    };

    Ok(Etx { env, ctx })
}

#[rustfmt::skip]
pub fn setup_etx_primed() -> Result<Etx> {
    let etx = setup_etx()?;

    // Primer buys liquidity tokens, establishing a stable price
    etx.exec_user_tx(PRIMER, |u| etx.ctx.user_buy_unpriced(u))?;

    /* ----- */ etx.advance_block(); /* ----- */

    Ok(etx)
}

// The two token addresses in canonical (ascending) order, matching the
// factory's own sort.
fn sorted(tokens: Addresses) -> Addresses {
    if tokens[0] <= tokens[1] {
        tokens
    } else {
        [tokens[1], tokens[0]]
    }
}

// Deploy and init A/B token contracts, given the hash of a registered token
// contract.
fn ab_tokens_deploy_init(token_hash: &SHA256Hash) -> Addresses {
    assert_eq!(&get_current_address(), &TEST_ADDR);

    // Deploy contracts for two tokens that we'd like to swap between
    hash_ident! { static TOKEN_0_NONCE: SHA256Hash; }
    hash_ident! { static TOKEN_1_NONCE: SHA256Hash; }
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
