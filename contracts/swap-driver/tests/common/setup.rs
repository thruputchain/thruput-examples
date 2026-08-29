use super::*;

// Storage tokens granted to each contract under the default cost model, well
// above what these tests spend.
const CONTRACT_FUNDING: i64 = 1_000_000_000;

// How many requests the driver under test will hold at once.  Deliberately
// far smaller than the figure the factory deploys with, so a test can reach
// the ceiling in a handful of transactions; comfortably above the depth any
// other test here queues.
pub const MAX_QUEUE_LEN: u32 = 8;

// The crank floor under test.  Deliberately below `MAX_QUEUE_LEN`, so that a
// full queue exercises the cap (a crank owes the floor, not the backlog) and a
// shorter one exercises the floor tracking what is waiting.
pub const MIN_CRANK_BATCH: u32 = 4;

// Deploy nonces, at module scope so a contract's deterministic address can be
// computed (and funded) before it is deployed.
hash_ident! { static TOKEN_0_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_1_NONCE: SHA256Hash; }
hash_ident! { static LP_NONCE: SHA256Hash; }
hash_ident! { static HANDLER_NONCE: SHA256Hash; }
hash_ident! { static DRIVER_NONCE: SHA256Hash; }

// Under the default cost model a contract pays for the storage it writes.  Grant
// storage tokens to the (deterministic) address `deployer` will deploy `hash` to
// with `nonce`, so the freshly deployed contract is solvent.
fn deploy_address_of(
    env: &TestEnvironmentHandle,
    deployer: &ContractAddress,
    nonce: &SHA256Hash,
    hash: &SHA256Hash,
) -> Address {
    exec_tx(env, deployer, || get_deploy_address(nonce, hash)).expect("compute deploy address")
}

fn fund_deploy_target(
    env: &TestEnvironmentHandle,
    deployer: &ContractAddress,
    nonce: &SHA256Hash,
    hash: &SHA256Hash,
) {
    let addr = deploy_address_of(env, deployer, nonce, hash);
    env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
}

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

    // Register the token contract
    let token_contract = erc20::register_mock_contract(&env);
    let token_hash = *token_contract.as_hash();

    // Register the request-handler contract
    let handler_contract = swap_handler::register_mock_contract(&env);
    let handler_hash = *handler_contract.as_hash();

    // Register the driver contract
    let driver_contract = swap_driver::register_mock_contract(&env);
    let driver_hash = *driver_contract.as_hash();

    setup_contracts(&env, token_hash, handler_hash, driver_hash)
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

    let token_hash = env.setup_create_contract(&token_contract);
    let handler_hash = env.setup_create_contract(&handler_contract);
    let driver_hash = env.setup_create_contract(&driver_contract);

    setup_contracts(&env, token_hash, handler_hash, driver_hash)
}

#[rustfmt::skip]
pub fn setup_contracts(
    env: &TestEnvironmentHandle,
    token_hash: SHA256Hash,
    handler_hash: SHA256Hash,
    driver_hash: SHA256Hash,
) -> Result<Etx> {

    // Pre-fund the test addresses and each contract we deploy (at its
    // deterministic address), so their storage writes are solvent under the
    // cost model.
    for u in USERS {
        env.setup_grant_storage_tokens(u.addr, CONTRACT_FUNDING);
    }
    fund_deploy_target(env, &TEST_ADDR, &TOKEN_0_NONCE, &token_hash);
    fund_deploy_target(env, &TEST_ADDR, &TOKEN_1_NONCE, &token_hash);
    fund_deploy_target(env, &FACTORY_ADDR, &LP_NONCE, &token_hash);
    fund_deploy_target(env, &FACTORY_ADDR, &HANDLER_NONCE, &handler_hash);
    fund_deploy_target(env, &FACTORY_ADDR, &DRIVER_NONCE, &driver_hash);

    // Deploy and init the A/B token contracts
    let token_addrs = exec_tx(env, &TEST_ADDR, || ab_tokens_deploy_init(&token_hash))?;

    /* ----- */ env.advance_block(); /* ----- */

    // Seed our users with A/B tokens
    exec_tx(env, &TEST_ADDR, || airdrop_tokens(&token_addrs));

    /* ----- */ env.advance_block(); /* ----- */

    // As the factory, deploy and init the handler.  It is the pool: it adopts
    // the LP token, holds the reserves, and performs the pair's operations
    // itself.
    // The handler takes requests from its driver alone, and the driver is
    // deployed below -- but to a deterministic address, so it can be told now.
    let driver_addr_predicted = deploy_address_of(env, &FACTORY_ADDR, &DRIVER_NONCE, &driver_hash);

    let (request_handler_addr, liquidity_token) = exec_tx(env, &FACTORY_ADDR, || {
        handler_deploy_init(&handler_hash, &token_hash, token_addrs, &driver_addr_predicted)
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // As the factory, deploy and init a driver contract (pointed at the handler)
    let driver_addr = exec_tx(env, &FACTORY_ADDR, || {
        driver_deploy_init(&driver_hash, &request_handler_addr)
    })?;
    assert_eq!(
        driver_addr, driver_addr_predicted,
        "the driver must land at the address the handler was told"
    );

    /* ----- */ env.advance_block(); /* ----- */

    let env = env.clone();
    let ctx = Ctx {
        driver_addr,
        request_handler_addr,
        liquidity_token,
        token_addrs
    };

    Ok(Etx { env, ctx })
}

#[rustfmt::skip]
pub fn setup_etx_primed() -> Result<Etx> {
    let etx = setup_etx()?;

    // Primer buys liquidity tokens, establishing a stable price
    etx.user_buy_unpriced(PRIMER)?;

    /* ----- */ etx.advance_block(); /* ----- */

    Ok(etx)
}

// Contract code

// Deploy and init A/B token contracts, given the hash of a registered token
// contract.
fn ab_tokens_deploy_init(token_hash: &SHA256Hash) -> Addresses {
    assert_eq!(&get_current_address(), &TEST_ADDR);

    // Deploy contracts for two tokens that we'd like to swap between
    let token0_addr = deploy_contract(&TOKEN_0_NONCE, token_hash);
    let token1_addr = deploy_contract(&TOKEN_1_NONCE, token_hash);

    #[cfg(not(feature = "erc20_metadata"))]
    {
        let token0 = ERC20Client::new(&token0_addr);
        let token1 = ERC20Client::new(&token1_addr);

        // Initialize the token contracts, putting them under control of the test
        token0.initialize(TEST.addr);
        token1.initialize(TEST.addr);
    }

    #[cfg(feature = "erc20_metadata")]
    {
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
    }

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

// Deploy and init the handler, which is the pool: it adopts the LP token and
// performs the pair's operations in its own frame.
fn handler_deploy_init(
    handler_hash: &SHA256Hash,
    token_hash: &SHA256Hash,
    token_addrs: Addresses,
    driver_addr: &Address,
) -> (Address, Address) {
    assert_eq!(&get_current_address(), &FACTORY_ADDR);

    // Deploy the LP-token contract (to be initialized by the handler)
    let lp_addr = deploy_contract(&LP_NONCE, token_hash);

    let handler_addr = deploy_contract(&HANDLER_NONCE, handler_hash);
    let handler = SwapHandlerClient::new(&handler_addr);

    handler.initialize(
        &FACTORY_ADDR,
        &token_addrs[0],
        &token_addrs[1],
        &lp_addr,
        driver_addr,
    );

    (handler_addr, handler.pool_state().liquidity_token)
}

// Deploy and init a driver contract, pointed at the request handler.
fn driver_deploy_init(driver_hash: &SHA256Hash, handler_addr: &Address) -> Address {
    assert_eq!(&get_current_address(), &FACTORY_ADDR);

    let driver_addr = deploy_contract(&DRIVER_NONCE, driver_hash);

    let driver = SwapDriverClient::new(&driver_addr);

    driver.initialize(handler_addr, &ROUTER_ADDR, MAX_QUEUE_LEN, MIN_CRANK_BATCH);

    driver_addr
}
