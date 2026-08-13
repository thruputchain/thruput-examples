//! Tests for the swap factory: one-transaction suite bring-up, the pair
//! registry, and the protocol fee flowing to the factory's `fee_to`.

use groundhog_erc20_if::ERC20Client;
use sdk::*;
use swap_factory::{SwapFactoryClient, SwapFactoryClientError, SwapFactoryError};
use swap_if::SwapHashes;
use swap_pair::SwapPairClient;
use swap_pair::u256::U256;

hash_ident! { pub static DEPLOYER: ContractAddress; }
hash_ident! { pub static FEE_ADDR: ContractAddress; }

// Enough for the fee test's prime + donation + second add.
const SUPPLY: u128 = 3_000_000;

// Storage tokens granted to each contract under the default cost model, well
// above what these tests spend.
const CONTRACT_FUNDING: i64 = 1_000_000_000;

// Deploy nonces, at module scope so a contract's deterministic address can be
// computed (and funded) before it is deployed.
hash_ident! { static T0_NONCE: SHA256Hash; }
hash_ident! { static T1_NONCE: SHA256Hash; }
hash_ident! { static FACTORY_NONCE: SHA256Hash; }

// Under the default cost model a contract pays for the storage it writes.  Grant
// storage tokens to the (deterministic) address `DEPLOYER` will deploy `hash` to
// with `nonce`, so the freshly deployed contract is solvent.
fn fund_deploy_target(env: &TestEnvironmentHandle, nonce: &SHA256Hash, hash: &SHA256Hash) {
    let addr = exec_tx(env, &DEPLOYER, || get_deploy_address(nonce, hash))
        .expect("compute deploy address");
    env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
}

struct Setup {
    env: TestEnvironmentHandle,
    factory: ContractAddress,
    token0: ContractAddress,
    token1: ContractAddress,
}

// Register the suite's contracts, deploy two funded tokens, and deploy+init a
// factory with `fee_to = Some(FEE_ADDR)`.
fn setup() -> Setup {
    let env = sdk::TestEnvironment::new(None); // use default cost model

    let hashes = SwapHashes {
        token: *erc20::register_mock_contract(&env).as_hash(),
        pair: *swap_pair::register_mock_contract(&env).as_hash(),
        handler: *swap_handler::register_mock_contract(&env).as_hash(),
        driver: *swap_driver::register_mock_contract(&env).as_hash(),
    };
    let factory_hash = *swap_factory::register_mock_contract(&env).as_hash();

    // Under the default cost model each contract pays for the storage it writes,
    // so pre-fund the deployer and the contracts it deploys directly.
    env.setup_grant_storage_tokens(&DEPLOYER, CONTRACT_FUNDING);
    fund_deploy_target(&env, &T0_NONCE, &hashes.token);
    fund_deploy_target(&env, &T1_NONCE, &hashes.token);
    fund_deploy_target(&env, &FACTORY_NONCE, &factory_hash);

    // Deploy + init two tokens, minting a supply to the deployer.
    let (token0, token1) = exec_tx(&env, &DEPLOYER, || {
        let t0 = deploy_contract(&T0_NONCE, &hashes.token);
        let t1 = deploy_contract(&T1_NONCE, &hashes.token);
        ERC20Client::new(&t0).initialize(&DEPLOYER);
        ERC20Client::new(&t1).initialize(&DEPLOYER);
        ERC20Client::new(&t0).mint(&DEPLOYER, SUPPLY);
        ERC20Client::new(&t1).mint(&DEPLOYER, SUPPLY);
        (t0, t1)
    })
    .unwrap();
    env.advance_block();

    // Deploy + init the factory.
    let factory = exec_tx(&env, &DEPLOYER, || {
        let f = deploy_contract(&FACTORY_NONCE, &factory_hash);
        SwapFactoryClient::new(&f).initialize(hashes, Some(FEE_ADDR));
        f
    })
    .unwrap();
    env.advance_block();

    // Pre-fund the pair's contracts, which the factory deploys inside
    // `create_pair` (called by the tests).
    let predicted = exec_tx(&env, &DEPLOYER, || {
        SwapFactoryClient::new(&factory).predict_pair(&token0, &token1)
    })
    .unwrap();
    for addr in [
        predicted.liquidity_token,
        predicted.pair,
        predicted.handler,
        predicted.driver,
    ] {
        env.setup_grant_storage_tokens(&addr, CONTRACT_FUNDING);
    }

    Setup {
        env: env.clone(),
        factory,
        token0,
        token1,
    }
}

#[test]
fn create_pair_brings_up_suite() {
    let s = setup();

    // The addresses the factory predicts it will deploy to (used off-chain to
    // pre-fund the contracts before they are initialized).
    let predicted = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).predict_pair(&s.token0, &s.token1)
    })
    .unwrap();

    // The whole suite is deployed and wired in a single transaction.  If any
    // sub-initialization had failed, `create_pair` would have thrown.
    let suite = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).create_pair(&s.token0, &s.token1)
    })
    .unwrap();
    s.env.advance_block();

    // The prediction matched what was actually deployed -- the invariant the
    // testkit sim relies on to pre-fund the contracts.
    assert_eq!(predicted, suite);

    exec_tx(&s.env, &DEPLOYER, || {
        let factory = SwapFactoryClient::new(&s.factory);

        // Registry, order-independent.
        assert_eq!(factory.get_pair(&s.token0, &s.token1), Some(suite.pair));
        assert_eq!(factory.get_pair(&s.token1, &s.token0), Some(suite.pair));
        assert_eq!(factory.all_pairs_length(), 1);
        assert_eq!(factory.pair_at(0), Some(suite.pair));
        assert_eq!(factory.fee_to(), Some(FEE_ADDR));

        // The pair adopted its LP token and is initialized (empty reserves).
        let pair = SwapPairClient::new(&suite.pair);
        assert_eq!(pair.liquidity_token(), suite.liquidity_token);
        let (r0, r1, _) = pair.get_reserves();
        assert_eq!((r0, r1), (0, 0));
    })
    .unwrap();

    // Creating the same pair again is rejected.
    let dup = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).try_create_pair(&s.token0, &s.token1)
    })
    .unwrap();
    assert!(matches!(
        dup,
        Err(SwapFactoryClientError::SwapFactoryError(
            SwapFactoryError::PairExists
        ))
    ));
}

#[test]
fn fee_accrues_to_factory_fee_to() {
    let s = setup();

    let suite = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).create_pair(&s.token0, &s.token1)
    })
    .unwrap();
    s.env.advance_block();

    let (pair, lp, t0, t1) = (suite.pair, suite.liquidity_token, s.token0, s.token1);

    // Prime: the deployer adds equal liquidity.  This first liquidity event
    // records `k_last` but mints no fee (there is no prior k).
    let prime: u128 = 1_000_000;
    exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&t0).transfer(&pair, prime);
        ERC20Client::new(&t1).transfer(&pair, prime);
        SwapPairClient::new(&pair).mint_lp(&DEPLOYER, None);
    })
    .unwrap();
    s.env.advance_block();

    let fee_before = exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&lp).get_balance_of(&FEE_ADDR)
    })
    .unwrap();
    assert_eq!(fee_before, 0);

    // Grow k: donate to the pair and `sync` (as accrued swap fees would).
    let donate: u128 = 1_000_000;
    exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&t0).transfer(&pair, donate);
        ERC20Client::new(&t1).transfer(&pair, donate);
        SwapPairClient::new(&pair).sync();
    })
    .unwrap();
    s.env.advance_block();

    // Snapshot the reserves and supply the next liquidity event will see.
    let (r0, r1, _) = exec_tx(&s.env, &DEPLOYER, || {
        SwapPairClient::new(&pair).get_reserves()
    })
    .unwrap();
    let supply = exec_tx(&s.env, &DEPLOYER, || {
        SwapPairClient::new(&pair).get_liquidity()
    })
    .unwrap();
    // k at the previous liquidity event (the prime, with equal reserves).
    let k_last = U256::from(prime) * U256::from(prime);

    // A second liquidity event triggers the protocol-fee mint to `fee_to`.
    let add: u128 = 1_000_000;
    exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&t0).transfer(&pair, add);
        ERC20Client::new(&t1).transfer(&pair, add);
        SwapPairClient::new(&pair).mint_lp(&DEPLOYER, None);
    })
    .unwrap();
    s.env.advance_block();

    let fee = exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&lp).get_balance_of(&FEE_ADDR)
    })
    .unwrap();

    // Expected: totalSupply * (rootK - rootKLast) / (5 * rootK + rootKLast),
    // computed independently from the on-chain reserves and supply.
    let root_k = (U256::from(r0) * U256::from(r1)).integer_sqrt();
    let root_k_last = k_last.integer_sqrt();
    let expected =
        U256::from(supply) * (root_k - root_k_last) / (root_k * U256::from(5) + root_k_last);

    // The fee reached the factory's `fee_to`, proving the pair consulted the
    // factory dynamically.
    assert!(expected > U256::ZERO);
    assert_eq!(U256::from(fee), expected);
}

// Run `f` in a transaction called from `addr`, returning its value on success.
fn exec_tx<F, T>(
    env: &TestEnvironmentHandle,
    addr: &ContractAddress,
    f: F,
) -> Result<T, TransactResult>
where
    F: Fn() -> T + std::panic::RefUnwindSafe,
{
    use std::sync::{Arc, Mutex};

    let ret: Arc<Mutex<Option<T>>> = Arc::new(Mutex::new(None));
    let r = env.transact(|tx| {
        tx.call(addr).run(|| {
            let ret = Arc::clone(&ret);
            *ret.lock().unwrap() = Some(f());
        })
    });
    let v = Mutex::into_inner(Arc::into_inner(ret).unwrap()).unwrap();

    if r.is_success() {
        Ok(v.unwrap())
    } else {
        Err(r)
    }
}
