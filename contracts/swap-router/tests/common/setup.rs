use super::*;
use std::env;
use swap_factory::{SwapFactoryClient, SwapHashes};

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

    // Register the contracts the factory deploys, plus the factory and the
    // single suite-wide router (both deployed directly).
    let hashes = SwapHashes {
        token: *erc20::register_mock_contract(&env).as_hash(),
        pair: *swap_pair::register_mock_contract(&env).as_hash(),
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
    let load_wasm = |name: &str| load_wasm_contract_instrumented(guest_path(name, "wasm"), false);

    let token_contract = load("erc20");
    let pair_contract = load_wasm("swap_pair");
    let handler_contract = load("swap_handler");
    let driver_contract = load("swap_driver");
    let router_contract = load("swap_router");
    let factory_contract = load("swap_factory");

    let env = sdk::TestEnvironment::new(None); // use default cost model

    let hashes = SwapHashes {
        token: env.setup_create_contract(&token_contract),
        pair: env.setup_create_contract(&pair_contract),
        handler: env.setup_create_contract(&handler_contract),
        driver: env.setup_create_contract(&driver_contract),
    };
    let factory_hash = env.setup_create_contract(&factory_contract);
    let router_hash = env.setup_create_contract(&router_contract);

    setup_contracts(&env, hashes, factory_hash, router_hash)
}

// REMOVE THIS with sdk_rs >= 0.17.4
#[cfg(feature = "guest_test")]
pub fn load_wasm_contract_instrumented<P>(path: P, please_instrument: bool) -> Contract
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

// Storage tokens granted to each contract under the default cost model, well
// above what the swap flow spends.
const CONTRACT_FUNDING: i64 = 1_000_000_000;

// Deploy nonces, at module scope so a contract's deterministic address can be
// computed (and funded) before it is actually deployed.
hash_ident! { static TOKEN_0_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_1_NONCE: SHA256Hash; }
hash_ident! { static FACTORY_NONCE: SHA256Hash; }
hash_ident! { static ROUTER_NONCE: SHA256Hash; }

// Under the default cost model, a contract must pay for the storage it writes.
// Grant storage tokens to the (deterministic) address `TEST_ADDR` will deploy
// `hash` to with `nonce`, so the freshly deployed contract is solvent.
fn fund_deploy_target(env: &TestEnvironmentHandle, nonce: &SHA256Hash, hash: &SHA256Hash) {
    let addr = exec_tx(env, &TEST_ADDR, || get_deploy_address(nonce, hash))
        .expect("compute deploy address");
    env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
}

// Build the whole suite through the factory: deploy the A/B tokens, then have
// a freshly deployed factory create the pair, LP token, request handler,
// driver, and router in a single transaction.
#[rustfmt::skip]
pub fn setup_contracts(
    env: &TestEnvironmentHandle,
    hashes: SwapHashes,
    factory_hash: SHA256Hash,
    router_hash: SHA256Hash,
) -> Result<Etx> {

    // Under the default cost model each contract pays for the storage it
    // writes, so pre-fund everything before it is deployed: the test-user
    // addresses, and each directly-deployed contract.
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

    // Canonical token ordering -- the factory sorts the pair internally, so we
    // track the tokens in the same order for `token0()`/`token1()` to line up
    // with the pair's reserve0/reserve1.
    let token_addrs = sorted(deployed);

    // Deploy and initialize the factory (protocol fee disabled).
    let factory_addr = exec_tx(env, &TEST_ADDR, move || {
        let factory_addr = deploy_contract(&FACTORY_NONCE, &factory_hash);
        SwapFactoryClient::new(&factory_addr).initialize(hashes, None);
        factory_addr
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // Deploy the single, suite-wide router, pointed at the factory.
    let router_addr = exec_tx(env, &TEST_ADDR, move || {
        let router_addr = deploy_contract(&ROUTER_NONCE, &router_hash);
        SwapRouterClient::new(&router_addr).initialize(&factory_addr);
        router_addr
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    // The factory deploys this pair's contracts (LP, pair, handler, driver)
    // inside `create_pair`, so pre-fund them at their predicted addresses first.
    let predicted = exec_tx(env, &TEST_ADDR, move || {
        SwapFactoryClient::new(&factory_addr).predict_pair(&token_addrs[0], &token_addrs[1])
    })?;
    for addr in [
        predicted.liquidity_token,
        predicted.pair,
        predicted.handler,
        predicted.driver,
    ] {
        env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
    }

    // Create this pair's contracts via the factory.
    let suite = exec_tx(env, &TEST_ADDR, move || {
        SwapFactoryClient::new(&factory_addr).create_pair(&token_addrs[0], &token_addrs[1])
    })?;

    /* ----- */ env.advance_block(); /* ----- */

    let env = env.clone();
    let ctx = Ctx {
        router_addr,
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
