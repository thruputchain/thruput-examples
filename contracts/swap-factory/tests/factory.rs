//! Tests for the swap factory: one-transaction pool bring-up, the pair
//! registry, and the protocol fee flowing to the factory's `fee_to`.

use groundhog_erc20_if::ERC20Client;
use sdk::*;
use swap_factory::{Addresses, SwapFactoryClient, SwapFactoryClientError, SwapFactoryError};
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

// Register the pool's contracts, deploy two funded tokens, and deploy+init a
// factory with `fee_to = Some(FEE_ADDR)`.
fn setup() -> Setup {
    setup_with_fee(Some(FEE_ADDR))
}

// The pool's contracts, natively for ordinary tests and as built guest
// binaries under `guest_test` -- where gas is metered for real, which is what
// the protocol-fee calibration needs.
#[cfg(not(feature = "guest_test"))]
fn register_contracts(env: &TestEnvironmentHandle) -> (SwapHashes, SHA256Hash) {
    (
        SwapHashes {
            token: *erc20::register_mock_contract(env).as_hash(),
            pair: *swap_pair::register_mock_contract(env).as_hash(),
            handler: *swap_handler::register_mock_contract(env).as_hash(),
            driver: *swap_driver::register_mock_contract(env).as_hash(),
        },
        *swap_factory::register_mock_contract(env).as_hash(),
    )
}

#[cfg(feature = "guest_test")]
fn register_contracts(env: &TestEnvironmentHandle) -> (SwapHashes, SHA256Hash) {
    let load = |name: &str| load_rv32_contract(format!("../../target/groundhog/{name}.rv32a"));

    (
        SwapHashes {
            token: env.setup_create_contract(&load("erc20")),
            pair: env.setup_create_contract(&load("swap_pair")),
            handler: env.setup_create_contract(&load("swap_handler")),
            driver: env.setup_create_contract(&load("swap_driver")),
        },
        env.setup_create_contract(&load("swap_factory")),
    )
}

fn setup_with_fee(fee_to: Option<ContractAddress>) -> Setup {
    let env = sdk::TestEnvironment::new(None); // use default cost model

    let (hashes, factory_hash) = register_contracts(&env);

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
        SwapFactoryClient::new(&f).initialize(hashes, fee_to);
        f
    })
    .unwrap();
    env.advance_block();

    // Pre-fund the pair's contracts, which the factory deploys inside
    // `create_pair` (called by the tests).
    let predicted = exec_tx(&env, &DEPLOYER, || {
        SwapFactoryClient::new(&factory).pool_addresses(&token0, &token1)
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
fn create_pair_brings_up_pool() {
    let s = setup();

    // The addresses the factory predicts it will deploy to (used off-chain to
    // pre-fund the contracts before they are initialized).
    let predicted = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).pool_addresses(&s.token0, &s.token1)
    })
    .unwrap();

    // The whole pool is deployed and wired in a single transaction.  If any
    // sub-initialization had failed, `create_pair` would have thrown.
    let pool = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).create_pair(&s.token0, &s.token1)
    })
    .unwrap();
    s.env.advance_block();

    // The prediction matched what was actually deployed -- the invariant the
    // testkit sim relies on to pre-fund the contracts.
    assert_eq!(predicted, pool);

    exec_tx(&s.env, &DEPLOYER, || {
        let factory = SwapFactoryClient::new(&s.factory);

        // Registry, order-independent.
        assert_eq!(factory.get_pair(&s.token0, &s.token1), Some(pool.pair));
        assert_eq!(factory.get_pair(&s.token1, &s.token0), Some(pool.pair));
        assert_eq!(factory.all_pairs_length(), 1);
        assert_eq!(factory.fee_to(), Some(FEE_ADDR));

        // Enumeration: the creation-ordered list yields the pool's two tokens
        // (canonically ordered), which `pool_addresses` resolves back to the
        // pool that was just created.  One past the end is `None`.
        let tokens = factory.pair_at(0).expect("pair 0 in bounds");
        assert_eq!(tokens, sorted([s.token0, s.token1]));
        assert_eq!(factory.pool_addresses(&tokens[0], &tokens[1]), pool);
        assert_eq!(factory.pair_at(1), None);

        // The pair adopted its LP token and is initialized (empty reserves).
        let pair = SwapPairClient::new(&pool.pair);
        assert_eq!(pair.liquidity_token(), pool.liquidity_token);
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

    let (pair, lp, t0, t1, handler) = prime_and_grow(&s);

    let fee_before = exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&lp).get_balance_of(&FEE_ADDR)
    })
    .unwrap();
    assert_eq!(fee_before, 0, "the first liquidity event mints no fee");

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
    let k_last = U256::from(PRIME) * U256::from(PRIME);

    // A second liquidity event triggers the protocol-fee mint to `fee_to`.
    second_liquidity_event(&s.env, pair, t0, t1, handler).assert_success();
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

// The liquidity a pool is primed with, and the amount donated afterwards to
// grow `k` the way accrued swap fees would.
const PRIME: u128 = 1_000_000;

// Create the pool, prime it with equal liquidity (which records `k_last` but
// mints no fee, there being no prior k), then donate and `sync` so that the
// next liquidity event finds a grown k.  Returns `(pair, lp, token0, token1)`.
fn prime_and_grow(
    s: &Setup,
) -> (
    ContractAddress,
    ContractAddress,
    ContractAddress,
    ContractAddress,
    ContractAddress,
) {
    // Copied out before the closures: capturing them through `s` would drag
    // the whole `Setup` -- and its environment handle -- across `exec_tx`'s
    // unwind boundary.
    let (factory, token0, token1) = (s.factory, s.token0, s.token1);

    let pool = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&factory).create_pair(&token0, &token1)
    })
    .unwrap();
    s.env.advance_block();

    let (pair, lp, t0, t1) = (pool.pair, pool.liquidity_token, token0, token1);
    let handler = pool.handler;

    // The deposit and the mint take separate transactions, because only the
    // pool's handler may mint -- and separate blocks, because the mint sizes
    // itself from balances its own block began with.
    exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&t0).transfer(&pair, PRIME);
        ERC20Client::new(&t1).transfer(&pair, PRIME);
    })
    .unwrap();
    s.env.advance_block();

    exec_tx(&s.env, &handler, || {
        SwapPairClient::new(&pair).mint_lp(&DEPLOYER, &DEPLOYER, None);
    })
    .unwrap();
    s.env.advance_block();

    exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&t0).transfer(&pair, PRIME);
        ERC20Client::new(&t1).transfer(&pair, PRIME);
        SwapPairClient::new(&pair).sync();
    })
    .unwrap();
    s.env.advance_block();

    (pair, lp, t0, t1, handler)
}

// The liquidity event that triggers the protocol fee, as its own transaction
// so that its cost can be read off the trace.
fn second_liquidity_event(
    env: &TestEnvironmentHandle,
    pair: ContractAddress,
    t0: ContractAddress,
    t1: ContractAddress,
    handler: ContractAddress,
) -> TransactResult {
    exec_tx(env, &DEPLOYER, move || {
        ERC20Client::new(&t0).transfer(&pair, PRIME);
        ERC20Client::new(&t1).transfer(&pair, PRIME);
    })
    .unwrap();
    env.advance_block();

    // The mint alone, as the handler, so its cost can be read off the trace.
    env.transact(|tx| {
        tx.call(&handler).run(move || {
            SwapPairClient::new(&pair).mint_lp(&DEPLOYER, &DEPLOYER, None);
        })
    })
}

/////////////////////// protocol-fee gas ////////////////////////////////////

// When a factory names a `fee_to`, every liquidity event after the first runs
// the pair's `mint_fee`: an integer square root over `U256`, a widening
// multiply and divide, and an LP mint.  None of that is reachable from
// `swap-driver`'s tests, whose pairs have no factory to consult, so the
// per-request budgets in `swap-if` are calibrated against the *cheap* branch
// and carry margin for this one.  This measures how much margin it needs, by
// running the same liquidity event with the fee enabled and disabled so that
// the difference is the branch and nothing else.
//
// Gas is only metered for real in the guest build, hence `guest_test`.
#[cfg(feature = "guest_test")]
#[test]
fn the_protocol_fee_branch_fits_within_the_liquidity_budgets() {
    // What `swap-driver`'s `request_gas` test measures for a liquidity
    // request, whose `mint_fee` takes the cheap branch.  Kept in step with
    // that test by hand: it measures the request, this measures the branch it
    // cannot reach, and only their sum bounds the dearest path.
    const ADD_LIQUIDITY_MEASURED: u64 = 141_154;
    const REMOVE_LIQUIDITY_MEASURED: u64 = 199_633;

    // The room the declared budget keeps over that sum.  The same figure
    // `request_gas` holds the cheap path to, so that the margin means the same
    // thing on both sides.
    const MARGIN: u64 = 2;

    let with_fee = measure_fee_event(Some(FEE_ADDR));
    let without_fee = measure_fee_event(None);
    let branch = with_fee - without_fee;

    println!("liquidity event, fee enabled : {with_fee}");
    println!("liquidity event, fee disabled: {without_fee}");
    println!("the protocol-fee branch      : {branch}");

    for (name, measured, declared) in [
        (
            "add_liquidity",
            ADD_LIQUIDITY_MEASURED,
            swap_if::ADD_LIQUIDITY_GAS,
        ),
        (
            "remove_liquidity",
            REMOVE_LIQUIDITY_MEASURED,
            swap_if::REMOVE_LIQUIDITY_GAS,
        ),
    ] {
        let worst = measured + branch;
        println!("{name:17} worst {worst:>7}  declared {declared:>7}");
        assert!(
            declared >= worst * MARGIN,
            "{name} declares {declared}, only {:.1}x the {worst} its dearest path \
             costs ({measured} measured, plus {branch} for the protocol fee); \
             wanted at least {MARGIN}x",
            declared as f64 / worst as f64,
        );
    }
}

#[cfg(feature = "guest_test")]
fn measure_fee_event(fee_to: Option<ContractAddress>) -> u64 {
    use groundhog_trace::transaction_trace::SyscallTraceBody;

    let s = setup_with_fee(fee_to);
    let (pair, _lp, t0, t1, handler) = prime_and_grow(&s);

    let r = second_liquidity_event(&s.env, pair, t0, t1, handler);
    r.assert_success();

    // The `mint_lp` invocation, which is where `mint_fee` runs.
    r.frame()
        .trace()
        .expect("traced")
        .system_calls
        .iter()
        .filter_map(|c| match &c.body {
            SyscallTraceBody::kInvoke { invoke } if invoke.inputs.address == pair => {
                Some(c.gas_remaining_at_start - c.gas_remaining_at_end)
            }
            _ => None,
        })
        .last()
        .expect("an invoke of the pair")
}

// The factory's canonical (ascending) token order, which its registry uses.
fn sorted(tokens: Addresses) -> Addresses {
    let [a, b] = tokens;
    if a <= b { [a, b] } else { [b, a] }
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
