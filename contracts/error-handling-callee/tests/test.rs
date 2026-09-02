use error_handling_callee::*;
use sdk::*;

static CALLEE_NONCE: SHA256Hash = sdk::sha256_static!("CALLEE_TEST_NONCE");

/// Helper: set up the callee contract in a test environment.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = error_handling_callee::register_mock_contract(&env);
    (env, *contract.as_hash())
}

#[test]
fn test_succeed() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let client = ErrorHandlingCalleeClient::new(&addr);

            assert_eq!(client.succeed(42), 42);
            assert_eq!(client.succeed(0), 0);
        })
    });
    result.assert_success();
}

#[test]
fn test_throw_error() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let client = ErrorHandlingCalleeClient::new(&addr);

            // throw_error throws CalleeError::Deliberate
            assert_eq!(
                client.try_throw_error().unwrap_err().try_as(),
                Some(CalleeError::Deliberate),
            );
        })
    });
    result.assert_success();
}

#[test]
fn test_fault() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let client = ErrorHandlingCalleeClient::new(&addr);

            // fault() panics, which becomes a Fault error
            match client.try_fault() {
                Err(CallError::Fault(_)) => {}
                other => panic!("Expected Fault, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_spin_completes() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let client = ErrorHandlingCalleeClient::new(&addr);

            assert_eq!(client.spin(10), 10);
        })
    });
    result.assert_success();
}
