use error_handling_callee::*;
use sdk::*;

static CALLEE_NONCE: SHA256Hash = sdk::sha256_static!("CALLEE_TEST_NONCE");

/// Helper: set up the callee contract in a test environment.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = env.register_mock(ErrorHandlingCallee::__mock);
    let contract_hash = env.setup_create_contract(&contract);
    (env, contract_hash)
}

#[test]
fn test_succeed() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            assert_eq!(client.succeed(42), 42);
            assert_eq!(client.succeed(0), 0);
        })
    });
    result.assert_success();
}

#[test]
fn test_abort_with_error() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            match client.try_abort_with_error() {
                Err(CallError::Abort(ref cross_exn)) => {
                    let err = cross_exn.as_contract_exn().expect("expected CalleeError");
                    assert_eq!(*err, CalleeError::Deliberate);
                }
                other => panic!("Expected abort with Deliberate, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_fault() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            match client.try_fault() {
                Err(CallError::Fault(_)) => {} // expected
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
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            assert_eq!(client.spin(10), 10);
        })
    });
    result.assert_success();
}
