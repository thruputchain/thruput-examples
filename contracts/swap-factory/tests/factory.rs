//! Tests for the swap factory: one-transaction pool bring-up, the pair registry, and the protocol
//! fee flowing to the factory's `fee_to`.

use swap_factory::{Addresses, POOL_FUNDING, SwapFactoryClient, SwapFactoryError};
use swap_handler::SwapHandlerClient;
use swap_if::SwapHashes;
use swap_pair::Pair;
use swap_pair::u256::U256;
use thruput_erc20_if::{Difference, ERC20Client};
use thruput_sdk::precompiles::ADDRESS_PRECOMPILED_HOG_TOKEN;
use thruput_sdk::storage::Node;
use thruput_sdk::*;

hash_ident! { pub static DEPLOYER: ContractAddress; }
hash_ident! { pub static FEE_ADDR: ContractAddress; }
// The factory hands this on to every driver it creates, as the only address whose requests they
// will take. Nothing here enqueues, so a bare address stands in for the router contract.
hash_ident! { pub static ROUTER_ADDR: ContractAddress; }

// Enough for the fee test's prime + donation + second add.
const SUPPLY: u128 = 3_000_000;

// Storage tokens granted to each contract under the default cost model, well above what these tests
// spend.
const CONTRACT_FUNDING: i64 = 1_000_000_000;

// What the tests hand `create_pair` for each of the pool's three contracts.
const FUNDING: u128 = POOL_FUNDING.recommended;

// Deploy nonces, at module scope so a contract's deterministic address can be computed (and funded)
// before it is deployed.
hash_ident! { static T0_NONCE: SHA256Hash; }
hash_ident! { static T1_NONCE: SHA256Hash; }
hash_ident! { static T2_NONCE: SHA256Hash; }
hash_ident! { static FACTORY_NONCE: SHA256Hash; }

// Under the default cost model a contract pays for the storage it writes. Grant storage tokens to
// the (deterministic) address `DEPLOYER` will deploy `hash` to with `nonce`, so the freshly
// deployed contract is solvent.
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
    // The token the factory deploys, for tests that need one more of them.
    token_hash: SHA256Hash,
}

// Register the pool's contracts, deploy two funded tokens, and deploy+init a factory with `fee_to =
// Some(FEE_ADDR)`.
fn setup() -> Setup {
    setup_with_fee(Some(FEE_ADDR))
}

// The pool's contracts, natively for ordinary tests and as built guest binaries under `guest_test`
// -- where gas is metered for real, which is what the protocol-fee calibration needs.
#[cfg(not(feature = "guest_test"))]
fn register_contracts(env: &TestEnvironmentHandle) -> (SwapHashes, SHA256Hash) {
    (
        SwapHashes {
            token: *erc20::register_mock_contract(env).as_hash(),
            handler: *swap_handler::register_mock_contract(env).as_hash(),
            driver: *swap_driver::register_mock_contract(env).as_hash(),
        },
        *swap_factory::register_mock_contract(env).as_hash(),
    )
}

#[cfg(feature = "guest_test")]
fn register_contracts(env: &TestEnvironmentHandle) -> (SwapHashes, SHA256Hash) {
    let load = |name: &str| load_rv32_contract(format!("../../target/thruput/{name}.rv32a"));

    (
        SwapHashes {
            token: env.setup_create_contract(&load("erc20")),
            handler: env.setup_create_contract(&load("swap_handler")),
            driver: env.setup_create_contract(&load("swap_driver")),
        },
        env.setup_create_contract(&load("swap_factory")),
    )
}

fn setup_with_fee(fee_to: Option<ContractAddress>) -> Setup {
    let env = thruput_sdk::TestEnvironment::new(None); // use default cost model

    let (hashes, factory_hash) = register_contracts(&env);

    // The native token is a precompile: it is live at its address from genesis and cannot be
    // redeployed. It still keeps its allowance ledger in its own storage, and pays for it like any
    // other contract.
    env.setup_grant_storage_tokens(&ADDRESS_PRECOMPILED_HOG_TOKEN, CONTRACT_FUNDING);

    // Under the default cost model each contract pays for the storage it writes, so pre-fund the
    // deployer and the contracts it deploys directly.
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
        ERC20Client::new(&t0).mint(&DEPLOYER, SUPPLY as i128);
        ERC20Client::new(&t1).mint(&DEPLOYER, SUPPLY as i128);
        (t0, t1)
    })
    .unwrap();
    env.advance_block();

    // Deploy + init the factory.
    let factory = exec_tx(&env, &DEPLOYER, || {
        let f = deploy_contract(&FACTORY_NONCE, &factory_hash);
        SwapFactoryClient::new(&f).initialize(hashes, fee_to, &ROUTER_ADDR);
        f
    })
    .unwrap();
    env.advance_block();

    // The factory funds the pool's three contracts as it deploys them, on the allowance the creator
    // grants it.
    exec_tx(&env, &DEPLOYER, || {
        ERC20Client::new(&ADDRESS_PRECOMPILED_HOG_TOKEN)
            .adjust_allowance(&factory, CONTRACT_FUNDING as Difference);
    })
    .unwrap();
    env.advance_block();

    Setup {
        env: env.clone(),
        factory,
        token0,
        token1,
        token_hash: hashes.token,
    }
}

// The registry's creation-ordered list is a `Vector`, whose length is written under an exclusive
// lock, so the factory creates at most one pool per block: of two `create_pair`s for *different*
// pairs in one block, the second's frame runs to completion but its commit is refused -- it is
// returned to the mempool, not failed -- and it lands in the next block.
#[test]
fn a_second_pool_in_one_block_is_deferred_not_failed() {
    let s = setup();

    // A third token, for a second pair.
    fund_deploy_target(&s.env, &T2_NONCE, &s.token_hash);
    let token_hash = s.token_hash;
    let token2 = exec_tx(&s.env, &DEPLOYER, || {
        let t2 = deploy_contract(&T2_NONCE, &token_hash);
        ERC20Client::new(&t2).initialize(&DEPLOYER);
        t2
    })
    .unwrap();
    s.env.advance_block();

    let (factory, token0, token1) = (s.factory, s.token0, s.token1);
    let create = |a: ContractAddress, b: ContractAddress| {
        exec_tx(&s.env, &DEPLOYER, move || {
            SwapFactoryClient::new(&factory).create_pair(&a, &b, FUNDING)
        })
    };

    create(token0, token1).expect("the first pool of the block");
    let deferred = create(token0, token2).expect_err("the second is deferred");
    deferred.assert_commit_failed_nondeterministically();
    s.env.advance_block();

    // Nothing of the deferred one reached the registry ...
    exec_tx(&s.env, &DEPLOYER, || {
        let factory = SwapFactoryClient::new(&factory);
        assert_eq!(factory.all_pairs_length(), 1);
        assert_eq!(factory.get_pair(&token0, &token2), None);
    })
    .unwrap();

    // ... and, retried, it goes through.
    let pool = create(token0, token2).expect("retried in the next block");
    s.env.advance_block();
    exec_tx(&s.env, &DEPLOYER, || {
        let factory = SwapFactoryClient::new(&factory);
        assert_eq!(factory.all_pairs_length(), 2);
        assert_eq!(factory.get_pair(&token0, &token2), Some(pool.handler));
    })
    .unwrap();
}

// A `funding` below the factory's floor is refused outright, before anything is deployed. This is
// the only under-funding the factory can report: past the floor a shortfall is only felt when the
// transaction's storage deposits are reserved, which returns the transaction to the mempool rather
// than aborting it -- see `SwapFactoryError::InsufficientFunding`.
#[test]
fn create_pair_refuses_funding_below_the_floor() {
    let s = setup();

    let result = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).try_create_pair(&s.token0, &s.token1, 1)
    })
    .unwrap();
    assert_eq!(
        result.unwrap_err().try_as(),
        Some(SwapFactoryError::InsufficientFunding)
    );
    s.env.advance_block();

    // Nothing was created: the pair is still absent from the registry.
    exec_tx(&s.env, &DEPLOYER, || {
        let factory = SwapFactoryClient::new(&s.factory);
        assert_eq!(factory.get_pair(&s.token0, &s.token1), None);
        assert_eq!(factory.all_pairs_length(), 0);
    })
    .unwrap();
}

#[test]
fn create_pair_brings_up_pool() {
    let s = setup();

    // The addresses the factory predicts it will deploy to (used off-chain to pre-fund the
    // contracts before they are initialized).
    let predicted = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).pool_addresses(&s.token0, &s.token1)
    })
    .unwrap();

    // The whole pool is deployed and wired in a single transaction. If any sub-initialization had
    // failed, `create_pair` would have thrown.
    let pool = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).create_pair(&s.token0, &s.token1, FUNDING)
    })
    .unwrap();
    s.env.advance_block();

    // The prediction matched what was actually deployed -- the invariant the testkit sim relies on
    // to pre-fund the contracts.
    assert_eq!(predicted, pool);

    exec_tx(&s.env, &DEPLOYER, || {
        let factory = SwapFactoryClient::new(&s.factory);

        // Registry, order-independent.
        assert_eq!(factory.get_pair(&s.token0, &s.token1), Some(pool.handler));
        assert_eq!(factory.get_pair(&s.token1, &s.token0), Some(pool.handler));
        assert_eq!(factory.all_pairs_length(), 1);
        assert_eq!(factory.fee_to(), Some(FEE_ADDR));

        // Enumeration: the creation-ordered list yields the pool's two tokens (canonically
        // ordered), which `pool_addresses` resolves back to the pool that was just created. One
        // past the end is `None`.
        let tokens = factory.pair_at(0).expect("pair 0 in bounds");
        assert_eq!(tokens, sorted([s.token0, s.token1]));
        assert_eq!(factory.pool_addresses(&tokens[0], &tokens[1]), pool);
        assert_eq!(factory.pair_at(1), None);

        // The pair adopted its LP token and is initialized (empty reserves).
        let pool_client = SwapHandlerClient::new(&pool.handler);
        let state = pool_client.pool_state();
        assert_eq!(state.liquidity_token, pool.liquidity_token);
        let [r0, r1] = state.reserves;
        assert_eq!((r0, r1), (0, 0));
    })
    .unwrap();

    // Creating the same pair again is rejected. (Both arms of `create_pair`'s guard, in the one
    // test, so the successful bring-up above is not repeated.)
    let dup = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&s.factory).try_create_pair(&s.token0, &s.token1, FUNDING)
    })
    .unwrap();
    assert_eq!(
        dup.unwrap_err().try_as(),
        Some(SwapFactoryError::PairExists)
    );
}

#[test]
fn fee_accrues_to_factory_fee_to() {
    let s = setup();

    let (pair, lp, t0, t1) = prime_and_grow(&s);

    let fee_before = exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&lp).get_balance_of(&FEE_ADDR)
    })
    .unwrap();
    assert_eq!(fee_before, 0, "the first liquidity event mints no fee");

    // Snapshot the reserves and supply the next liquidity event will see.
    let [r0, r1] = exec_tx(&s.env, &DEPLOYER, || {
        SwapHandlerClient::new(&pair).pool_state().reserves
    })
    .unwrap();
    let supply = exec_tx(&s.env, &DEPLOYER, || {
        SwapHandlerClient::new(&pair).pool_state().liquidity
    })
    .unwrap();
    // k at the previous liquidity event (the prime, with equal reserves).
    let k_last = U256::from(PRIME) * U256::from(PRIME);

    // A second liquidity event triggers the protocol-fee mint to `fee_to`.
    second_liquidity_event(&s.env, pair, t0, t1).assert_success();
    s.env.advance_block();

    let fee = exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&lp).get_balance_of(&FEE_ADDR)
    })
    .unwrap();

    // Expected: totalSupply * (rootK - rootKLast) / (5 * rootK + rootKLast), computed independently
    // from the on-chain reserves and supply.
    let root_k = (U256::from(r0) * U256::from(r1)).integer_sqrt();
    let root_k_last = k_last.integer_sqrt();
    let expected =
        U256::from(supply) * (root_k - root_k_last) / (root_k * U256::from(5) + root_k_last);

    // The fee reached the factory's `fee_to`, proving the pair consulted the factory dynamically.
    assert!(expected > U256::ZERO);
    assert_eq!(U256::from(fee as u128), expected);
}

// The liquidity a pool is primed with, and the amount donated afterwards to grow `k` the way
// accrued swap fees would.
const PRIME: u128 = 1_000_000;

// Create the pool, prime it with equal liquidity (which records `k_last` but mints no fee, there
// being no prior k), then donate and `sync` so that the next liquidity event finds a grown k.
// Returns `(pair, lp, token0, token1)`.
fn prime_and_grow(
    s: &Setup,
) -> (
    ContractAddress,
    ContractAddress,
    ContractAddress,
    ContractAddress,
) {
    // Copied out before the closures: capturing them through `s` would drag the whole `Setup` --
    // and its environment handle -- across `exec_tx`'s unwind boundary.
    let (factory, token0, token1) = (s.factory, s.token0, s.token1);

    let pool = exec_tx(&s.env, &DEPLOYER, || {
        SwapFactoryClient::new(&factory).create_pair(&token0, &token1, FUNDING)
    })
    .unwrap();
    s.env.advance_block();

    let (pair, lp, t0, t1) = (pool.handler, pool.liquidity_token, token0, token1);

    deposit_and_mint(&s.env, pair, t0, t1).assert_success();
    s.env.advance_block();

    exec_tx(&s.env, &DEPLOYER, || {
        ERC20Client::new(&t0).transfer(&pair, PRIME as i128);
        ERC20Client::new(&t1).transfer(&pair, PRIME as i128);
        SwapHandlerClient::new(&pair).sync();
    })
    .unwrap();
    s.env.advance_block();

    (pair, lp, t0, t1)
}

// The liquidity event that triggers the protocol fee, as its own transaction so that its cost can
// be read off the trace.
fn second_liquidity_event(
    env: &TestEnvironmentHandle,
    pair: ContractAddress,
    t0: ContractAddress,
    t1: ContractAddress,
) -> TransactResult {
    env.transact(|tx| deposit_and_mint_frame(tx, pair, t0, t1))
}

// A liquidity event: the depositor moves its tokens into the pool, and then the pool's own frame
// mints against them. Both in one transaction, so the mint sees the deposit -- a second transaction
// would read the balances its own block began with.
fn deposit_and_mint(
    env: &TestEnvironmentHandle,
    pool: ContractAddress,
    t0: ContractAddress,
    t1: ContractAddress,
) -> TransactResult {
    env.transact(|tx| deposit_and_mint_frame(tx, pool, t0, t1))
}

fn deposit_and_mint_frame(
    tx: &mut MockTransactionHandler,
    pool: ContractAddress,
    t0: ContractAddress,
    t1: ContractAddress,
) -> FrameResult {
    tx.call(&DEPLOYER)
        .run_continuable(|frame| {
            ERC20Client::new(&t0).transfer(&pool, PRIME as i128);
            ERC20Client::new(&t1).transfer(&pool, PRIME as i128);

            frame
                .child_call(&pool)
                .run(|| {
                    let mut pair: Node<Pair> = swap_handler::pair_state();
                    pair.mint_lp(&DEPLOYER);
                })
                .assert_success();

            FrameAction::Close
        })
        .finish()
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
