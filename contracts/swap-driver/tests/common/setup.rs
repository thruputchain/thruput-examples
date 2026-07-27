use super::*;

// Storage tokens granted to each contract under the default cost model, well
// above what these tests spend.
const CONTRACT_FUNDING: i64 = 1_000_000_000;

// Deploy nonces, at module scope so a contract's deterministic address can be
// computed (and funded) before it is deployed.
hash_ident! { static TOKEN_0_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_1_NONCE: SHA256Hash; }
hash_ident! { static LP_NONCE: SHA256Hash; }
hash_ident! { static PAIR_NONCE: SHA256Hash; }
hash_ident! { static HANDLER_NONCE: SHA256Hash; }
hash_ident! { static DRIVER_NONCE: SHA256Hash; }

// Under the default cost model a contract pays for the storage it writes.  Grant
// storage tokens to the (deterministic) address `deployer` will deploy `hash` to
// with `nonce`, so the freshly deployed contract is solvent.
fn fund_deploy_target(
    env: &TestEnvironmentHandle,
    deployer: &ContractAddress,
    nonce: &SHA256Hash,
    hash: &SHA256Hash,
) {
    let addr = exec_tx(env, deployer, || get_deploy_address(nonce, hash))
        .expect("compute deploy address");
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

    // Register the swap-pair contract
    let pair_contract = swap_pair::register_mock_contract(&env);
    let pair_hash = *pair_contract.as_hash();

    // Register the request-handler contract
    let handler_contract = swap_handler::register_mock_contract(&env);
    let handler_hash = *handler_contract.as_hash();

    // Register the driver contract
    let driver_contract = swap_driver::register_mock_contract(&env);
    let driver_hash = *driver_contract.as_hash();

    setup_contracts(&env, token_hash, pair_hash, handler_hash, driver_hash)
}

#[cfg(feature = "guest_test")]
pub fn setup_etx_guest() -> Result<Etx> {
    let guest_path =
        |name: &str, arch: &str| -> String { format!("../../target/groundhog/{name}.{arch}") };
    let load = |name: &str| load_rv32_contract(guest_path(name, "rv32a"));
    let load_wasm = |name: &str| load_wasm_contract_instrumented(guest_path(name, "wasm"), false);

    let token_contract = load("erc20");
    let pair_contract = load_wasm("swap_pair");
    let handler_contract = load("swap_handler");
    let driver_contract = load("swap_driver");
    let router_contract = load("swap_router");
    let factory_contract = load("swap_factory");

    let env = sdk::TestEnvironment::new(None); // use default cost model

    let token_hash = env.setup_create_contract(&token_contract);
    let pair_hash = env.setup_create_contract(&pair_contract);
    let handler_hash = env.setup_create_contract(&handler_contract);
    let driver_hash = env.setup_create_contract(&driver_contract);

    setup_contracts(&env, token_hash, pair_hash, handler_hash, driver_hash)
}

// REMOVE THIS with sdk_rs >= 0.17.4
#[cfg(feature = "guest_test")]
pub fn load_wasm_contract_instrumented<P>(
    path: P,
    please_instrument: bool
) -> Contract
where
    P: AsRef<std::path::Path>,
{
    assert!(!please_instrument);

    use crate::contract::ContractBlob;

    let wasm = std::fs::read(path.as_ref()).unwrap_or_else(|e| {
        panic!(
            "{}: couldn't load wasm: {}",
            path.as_ref().to_str().unwrap_or("?"),
            e
        )
    });

    let contract: ContractBlob = ContractBlob { data: BytesM(wasm) };

    Contract::kWasmi {
        wasmi_contract: contract,
    }
}

#[rustfmt::skip]
pub fn setup_contracts(
    env: &TestEnvironmentHandle,
    token_hash: SHA256Hash,
    pair_hash: SHA256Hash,
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
    fund_deploy_target(env, &FACTORY_ADDR, &PAIR_NONCE, &pair_hash);
    fund_deploy_target(env, &FACTORY_ADDR, &HANDLER_NONCE, &handler_hash);
    fund_deploy_target(env, &FACTORY_ADDR, &DRIVER_NONCE, &driver_hash);

    // Deploy and init the A/B token contracts
    let token_addrs = exec_tx(env, &TEST_ADDR, || ab_tokens_deploy_init(&token_hash))?;

    /* ----- */ env.advance_block(); /* ----- */

    // Seed our users with A/B tokens
    exec_tx(env, &TEST_ADDR, || airdrop_tokens(&token_addrs));

    /* ----- */ env.advance_block(); /* ----- */

    // As the factory, deploy and init a swap-pair contract
    let (pair_addr, liquidity_token) = exec_tx(env, &FACTORY_ADDR, || {
        swap_pair_deploy_init(&pair_hash, &token_hash, token_addrs)
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // As the factory, deploy and init the request-handler contract
    let request_handler_addr = exec_tx(env, &FACTORY_ADDR, || {
        request_handler_deploy_init(&handler_hash, &pair_addr, &token_addrs)
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // As the factory, deploy and init a driver contract (pointed at the handler)
    let driver_addr = exec_tx(env, &FACTORY_ADDR, || {
        driver_deploy_init(&driver_hash, &request_handler_addr)
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    let env = env.clone();
    let ctx = Ctx {
        driver_addr,
        request_handler_addr,
        pair_addr,
        liquidity_token,
        token_addrs
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

// Deploy and init a swap-pair contract, given hashes of a registered pair
// contract and a registered token contract.
fn swap_pair_deploy_init(
    pair_hash: &SHA256Hash,
    token_hash: &SHA256Hash,
    token_addrs: Addresses,
) -> (Address, Address) {
    assert_eq!(&get_current_address(), &FACTORY_ADDR);

    // Deploy the LP-token contract (to be initialized below by
    // `pair.initialize`)
    let lp_addr = deploy_contract(&LP_NONCE, token_hash);

    // Deploy a new swap-pair contract
    let pair_addr = deploy_contract(&PAIR_NONCE, pair_hash);

    let pair = SwapPairClient::new(&pair_addr);

    // Initialize the pair contract with the two tokens
    // (This also initializes its embedded LP-token implementation.)
    pair.initialize(&FACTORY_ADDR, &token_addrs[0], &token_addrs[1], &lp_addr);

    let liquidity_token = pair.liquidity_token();

    (pair_addr, liquidity_token)
}

// Deploy and init the request-handler contract, given the hash of a
// registered handler contract and the pair it should drive.
fn request_handler_deploy_init(
    handler_hash: &SHA256Hash,
    pair_addr: &Address,
    token_addrs: &Addresses,
) -> Address {
    assert_eq!(&get_current_address(), &FACTORY_ADDR);

    let handler_addr = deploy_contract(&HANDLER_NONCE, handler_hash);

    let handler = SwapHandlerClient::new(&handler_addr);

    handler.initialize(pair_addr, &token_addrs[0], &token_addrs[1]);

    handler_addr
}

// Deploy and init a driver contract, pointed at the request handler.
fn driver_deploy_init(driver_hash: &SHA256Hash, handler_addr: &Address) -> Address {
    assert_eq!(&get_current_address(), &FACTORY_ADDR);

    let driver_addr = deploy_contract(&DRIVER_NONCE, driver_hash);

    let driver = SwapDriverClient::new(&driver_addr);

    driver.initialize(handler_addr);

    driver_addr
}
