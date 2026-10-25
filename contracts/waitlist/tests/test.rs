use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;
use waitlist::{WaitlistClient, WaitlistError, register_mock_contract};

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("WAITLIST_NONCE");

// The backlog the fee steers toward. Small, so a test can exceed it.
const TARGET: u32 = 2;

// The most the fee can reach. Small, so a test can reach it.
const MAX_FEE: u64 = 3;

fn addr(name: &str) -> ContractAddress {
    <ContractAddress as Named>::named(name)
}

// Deploy and start a waitlist, and give each user some native tokens to pay fees with. Returns the
// waitlist's address, in the block after it started.
fn setup() -> (TestEnvironmentHandle, ContractAddress) {
    let env = TestEnvironment::no_cost();
    let hash = *register_mock_contract(&env).as_hash();
    for user in ["alice", "bob", "carol"] {
        env.setup_grant_storage_tokens(&addr(user), 1_000);
    }

    let deployed = env.transact(|tx| {
        tx.call(&addr("deployer")).run(move || {
            let list = deploy_contract(&NONCE, &hash);
            WaitlistClient::new(&list).initialize(TARGET, MAX_FEE);
            list
        })
    });
    deployed.assert_success();
    let list = deployed.assert_return_as::<ContractAddress>();

    env.advance_block();
    (env, list)
}

fn join(env: &TestEnvironmentHandle, user: &str, list: ContractAddress) -> TransactResult {
    env.transact(|tx| {
        tx.call(&addr(user))
            .run(move || WaitlistClient::new(&list).join())
    })
}

fn serve(env: &TestEnvironmentHandle, list: ContractAddress, count: u32) -> u32 {
    let r = env.transact(|tx| {
        tx.call(&addr("server"))
            .run(move || WaitlistClient::new(&list).serve(count))
    });
    r.assert_success();
    r.assert_return_as::<u32>()
}

fn fee(env: &TestEnvironmentHandle, list: ContractAddress) -> u64 {
    let r = env.transact(|tx| {
        tx.call(&addr("viewer"))
            .run(move || WaitlistClient::new(&list).fee())
    });
    r.assert_success();
    r.assert_return_as::<u64>()
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

// A short list is free to join, and needs no allowance.
#[test]
fn a_short_list_is_free_to_join() {
    let (env, list) = setup();

    for _ in 0..TARGET {
        let r = join(&env, "alice", list);
        r.assert_success();
        assert_eq!(r.assert_return_as::<u64>(), 0);
    }

    env.advance_block();
    assert_eq!(native_balance(&env, "alice"), 1_000);
}

// A backlog above the target puts a price on joining.
#[test]
fn a_backlog_raises_the_fee() {
    let (env, list) = setup();

    for _ in 0..2 * TARGET {
        join(&env, "bob", list).assert_success();
    }
    // Alice expects to pay, and lets the waitlist take a unit. (An allowance, like any write, is
    // visible from the next block.)
    env.transact(|tx| {
        tx.call(&addr("alice")).run(move || {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&list, 1);
        })
    })
    .assert_success();

    env.advance_block();

    let fee = fee(&env, list);
    assert_eq!(fee, 1, "a free list's fee rises a unit at a time");

    // Carol granted nothing, so she cannot pay, and is refused.
    assert!(!join(&env, "carol", list).is_success());

    // Alice pays exactly the fee.
    let paid = join(&env, "alice", list);
    paid.assert_success();
    assert_eq!(paid.assert_return_as::<u64>(), fee);

    env.advance_block();
    assert_eq!(native_balance(&env, "alice"), 1_000 - i128::from(fee));
}

// A backlog that nobody serves keeps raising the fee, block after block, with no one joining --
// but only as far as the maximum.
#[test]
fn a_lingering_backlog_raises_it_to_the_maximum() {
    let (env, list) = setup();

    for _ in 0..2 * TARGET {
        join(&env, "bob", list).assert_success();
    }
    env.advance_block();
    env.advance_block();
    assert_eq!(fee(&env, list), 2);

    for _ in 0..5 {
        env.advance_block();
    }
    assert_eq!(fee(&env, list), MAX_FEE);
}

// Serving the backlog brings the fee back down.
#[test]
fn serving_brings_it_back_down() {
    let (env, list) = setup();

    for _ in 0..2 * TARGET {
        join(&env, "bob", list).assert_success();
    }
    env.advance_block();
    assert_eq!(fee(&env, list), 1);

    assert_eq!(
        serve(&env, list, 10),
        2 * TARGET,
        "serves only who is waiting"
    );
    env.advance_block();
    assert_eq!(fee(&env, list), 0);
}

// The fee can be started only once: starting it again would make joining free.
#[test]
fn initializing_twice_is_refused() {
    let (env, list) = setup();

    let refused = env.transact(|tx| {
        tx.call(&addr("mallory")).run(move || {
            let err = WaitlistClient::new(&list)
                .try_initialize(TARGET, MAX_FEE)
                .unwrap_err();
            err.try_as() == Some(WaitlistError::AlreadyInitialized)
        })
    });
    refused.assert_success();
    assert!(refused.assert_return_as::<bool>());
}
