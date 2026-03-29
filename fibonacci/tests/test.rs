use fibonacci::*;
use sdk::*;

static FIB_NONCE: SHA256Hash = sdk::sha256_static!("FIB_TEST_NONCE");

/// Helper: set up the fibonacci contract in a test environment.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = env.register_mock(Fibonacci::__mock);
    let contract_hash = env.setup_create_contract(&contract);
    (env, contract_hash)
}

#[test]
fn test_fib_basic_values() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&FIB_NONCE, &contract_hash);
            let client = FibonacciClient::new(&addr);

            assert_eq!(client.compute(0), 0);
            assert_eq!(client.compute(1), 1);
            assert_eq!(client.compute(2), 1);
            assert_eq!(client.compute(3), 2);
            assert_eq!(client.compute(5), 5);
            assert_eq!(client.compute(10), 55);
            assert_eq!(client.compute(20), 6765);
        })
    });
    result.assert_success();
}

#[test]
fn test_fib_input_too_large() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&FIB_NONCE, &contract_hash);
            let client = FibonacciClient::new(&addr);

            // n=31 exceeds MAX_FIB_INPUT (30) — should throw FibError::InputTooLarge
            match client.try_compute(31) {
                Err(FibonacciClientError::FibError(FibError::InputTooLarge)) => {}
                other => panic!("Expected FibError::InputTooLarge, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_fib_emits_event() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&FIB_NONCE, &contract_hash);
            let client = FibonacciClient::new(&addr);
            client.compute(10);
        })
    });
    result.assert_success();
    result.assert_event_count(1);
    result.assert_event::<FibComputed>(0, |e| {
        assert_eq!(e.topic(0).unwrap(), FibComputed::SIGNATURE);
        assert_eq!(e.payload().input, 10);
        assert_eq!(e.payload().result, 55);
    });
}

#[test]
fn test_fib_multiple_calls_emit_multiple_events() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&FIB_NONCE, &contract_hash);
            let client = FibonacciClient::new(&addr);
            client.compute(5);
            client.compute(10);
        })
    });
    result.assert_success();
    result.assert_event_count(2);

    result.assert_event::<FibComputed>(0, |e| {
        assert_eq!(e.payload().input, 5);
        assert_eq!(e.payload().result, 5);
    });
    result.assert_event::<FibComputed>(1, |e| {
        assert_eq!(e.payload().input, 10);
        assert_eq!(e.payload().result, 55);
    });
}
