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

struct Setup {
    env: TestEnvironmentHandle,
    factory: ContractAddress,
    token0: ContractAddress,
    token1: ContractAddress,
}

// Register the suite's contracts, deploy two funded tokens, and deploy+init a
// factory with `fee_to = Some(FEE_ADDR)`.
fn setup() -> Setup {
    let env = TestEnvironment::no_cost();

    let hashes = SwapHashes {
        token: *erc20::register_mock_contract(&env).as_hash(),
        pair: *swap_pair::register_mock_contract(&env).as_hash(),
        handler: *swap_request::register_mock_contract(&env).as_hash(),
        driver: *swap_driver::register_mock_contract(&env).as_hash(),
        router: *swap_router::register_mock_contract(&env).as_hash(),
    };
    let factory_hash = *swap_factory::register_mock_contract(&env).as_hash();

    // Deploy + init two tokens and fund the deployer.
    let (token0, token1) = exec_tx(&env, &DEPLOYER, || {
        hash_ident! { static T0_NONCE: SHA256Hash; }
        hash_ident! { static T1_NONCE: SHA256Hash; }
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
        hash_ident! { static FACTORY_NONCE: SHA256Hash; }
        let f = deploy_contract(&FACTORY_NONCE, &factory_hash);
        SwapFactoryClient::new(&f).initialize(hashes, Some(FEE_ADDR));
        f
    })
    .unwrap();
    env.advance_block();

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

    // The whole suite is deployed and wired in a single transaction.  If any
    // sub-initialization had failed, `create_pair` would have thrown.
    let suite = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).create_pair(&s.token0, &s.token1)
    })
    .unwrap();
    s.env.advance_block();

    exec_tx(&s.env, &DEPLOYER, || {
        let factory = SwapFactoryClient::new(&s.factory);

        // Registry, order-independent.
        assert_eq!(factory.get_pair(&s.token0, &s.token1), Some(suite.pair));
        assert_eq!(factory.get_pair(&s.token1, &s.token0), Some(suite.pair));
        assert_eq!(factory.all_pairs_length(), 1);
        assert_eq!(factory.pair_at(0), suite.pair);
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
        SwapPairClient::new(&pair).mint_lp(&DEPLOYER);
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
        SwapPairClient::new(&pair).mint_lp(&DEPLOYER);
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
    assert!(expected > U256::zero());
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
