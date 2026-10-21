use counter::{CounterClient, register_mock_contract};
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("COUNTER_NONCE");

fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let test_contract = register_mock_contract(&env);
    let contract_hash = *test_contract.as_hash();
    (env, contract_hash)
}

#[test]
fn test_counter() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        let caller = <ContractAddress as Named>::named("test_counter");
        tx.call(&caller).run(move || {
            let addr = deploy_contract(&NONCE, &contract_hash);
            let client = CounterClient::new(&addr);

            assert_eq!(client.get(), 0);
            client.initialize(10);
            assert_eq!(client.get(), 10);

            client.increment(5);
            assert_eq!(client.get(), 15);

            client.decrement(3);
            assert_eq!(client.get(), 12);
        })
    })
    .assert_success();
}

#[test]
fn test_counter_underflow() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        let caller = <ContractAddress as Named>::named("test_counter_underflow");
        tx.call(&caller).run(move || {
            let addr = deploy_contract(&NONCE, &contract_hash);
            let client = CounterClient::new(&addr);

            client.initialize(5);

            // Balance rejects a decrease below zero during execution.
            match client.try_decrement(10) {
                Ok(_) => panic!("expected underflow"),
                Err(err) => assert_eq!(
                    err.try_as(),
                    Some(LibraryExn::NonNegativeIntUnderflow),
                    "expected underflow, got: {err:?}"
                ),
            }
            assert_eq!(client.get(), 5);
            client.decrement(5);
            assert_eq!(client.get(), 0);
        })
    })
    .assert_success();
}
