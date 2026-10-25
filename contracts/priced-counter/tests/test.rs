use priced_counter::{PricedCounterClient, PricedCounterError, register_mock_contract};
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("PRICED_COUNTER_NONCE");

// Increments per block the fee steers toward. Small, so a test can exceed it.
const TARGET: u32 = 2;

fn addr(name: &str) -> ContractAddress {
    <ContractAddress as Named>::named(name)
}

// Deploy and start a counter, and give each user some native tokens to pay fees with. Returns the
// counter's address, in the block after it started.
fn setup() -> (TestEnvironmentHandle, ContractAddress) {
    let env = TestEnvironment::no_cost();
    let hash = *register_mock_contract(&env).as_hash();
    for user in ["alice", "bob", "carol"] {
        env.setup_grant_storage_tokens(&addr(user), 1_000);
    }

    let deployed = env.transact(|tx| {
        tx.call(&addr("deployer")).run(move || {
            let counter = deploy_contract(&NONCE, &hash);
            PricedCounterClient::new(&counter).initialize(TARGET);
            counter
        })
    });
    deployed.assert_success();
    let counter = deployed.assert_return_as::<ContractAddress>();

    env.advance_block();
    (env, counter)
}

fn increment(env: &TestEnvironmentHandle, user: &str, counter: ContractAddress) -> TransactResult {
    env.transact(|tx| {
        tx.call(&addr(user))
            .run(move || PricedCounterClient::new(&counter).increment(1))
    })
}

fn count(env: &TestEnvironmentHandle, counter: ContractAddress) -> u64 {
    let r = env.transact(|tx| {
        tx.call(&addr("viewer"))
            .run(move || PricedCounterClient::new(&counter).get())
    });
    r.assert_success();
    r.assert_return_as::<u64>()
}

fn fee(env: &TestEnvironmentHandle, counter: ContractAddress) -> u128 {
    let r = env.transact(|tx| {
        tx.call(&addr("viewer"))
            .run(move || PricedCounterClient::new(&counter).fee())
    });
    r.assert_success();
    r.assert_return_as::<u128>()
}

fn native_balance(env: &TestEnvironmentHandle, user: &str) -> i128 {
    let user = addr(user);
    let r = env.transact(|tx| {
        tx.call(&addr("viewer"))
            .run(move || ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&user))
    });
    r.assert_success();
    r.assert_return_as::<i128>()
}

// While increments stay at the target, they are free, and need no allowance.
#[test]
fn quiet_increments_are_free() {
    let (env, counter) = setup();

    for _ in 0..TARGET {
        let r = increment(&env, "alice", counter);
        r.assert_success();
        assert_eq!(r.assert_return_as::<u128>(), 0);
    }

    env.advance_block();
    assert_eq!(count(&env, counter), u64::from(TARGET));
    assert_eq!(native_balance(&env, "alice"), 1_000);
}

// A block with more increments than the target puts a price on the next block's.
#[test]
fn a_busy_block_raises_the_fee() {
    let (env, counter) = setup();

    for _ in 0..2 * TARGET {
        increment(&env, "bob", counter).assert_success();
    }
    // Alice expects to pay, and lets the counter take a unit. (An allowance, like any write, is
    // visible from the next block.)
    env.transact(|tx| {
        tx.call(&addr("alice")).run(move || {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&counter, 1);
        })
    })
    .assert_success();

    env.advance_block();

    let fee = fee(&env, counter);
    assert_eq!(fee, 1, "a free counter's fee rises a unit at a time");

    // Carol granted nothing, so she cannot pay, and her increment is refused.
    assert!(!increment(&env, "carol", counter).is_success());

    // Alice pays exactly the fee.
    let paid = increment(&env, "alice", counter);
    paid.assert_success();
    assert_eq!(paid.assert_return_as::<u128>(), fee);

    env.advance_block();
    assert_eq!(native_balance(&env, "alice"), 1_000 - fee as i128);
}

// The fee can be started only once: starting it again would make entry free.
#[test]
fn initializing_twice_is_refused() {
    let (env, counter) = setup();

    let refused = env.transact(|tx| {
        tx.call(&addr("mallory")).run(move || {
            let err = PricedCounterClient::new(&counter)
                .try_initialize(TARGET)
                .unwrap_err();
            err.try_as() == Some(PricedCounterError::AlreadyInitialized)
        })
    });
    refused.assert_success();
    assert!(refused.assert_return_as::<bool>());
}
