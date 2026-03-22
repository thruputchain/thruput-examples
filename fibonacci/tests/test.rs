use fibonacci::*;
use sdk::*;

static FIB_NONCE: SHA256Hash = sdk::sha256_static!("FIB_TEST_NONCE");

/// Helper: set up the fibonacci contract in a test environment.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let test_contract = test_setup::register(&env);
    let contract_hash = env.setup_create_contract(&test_contract);
    (env, contract_hash)
}

#[test]
fn test_fib_basic_values() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&FIB_NONCE, &contract_hash);
            let mut client = FibonacciClient::new(&addr);

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
fn test_fib_input_too_large_aborts() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&FIB_NONCE, &contract_hash);
            let mut client = FibonacciClient::new(&addr);

            // n=31 exceeds MAX_FIB_INPUT (30) — should abort
            match client.try_compute(31) {
                Err(CallError::Abort(ref cross_exn)) => {
                    let err = cross_exn.as_contract_exn().expect("expected FibError");
                    assert_eq!(*err, FibError::InputTooLarge);
                }
                other => panic!("Expected abort with InputTooLarge, got: {:?}", other),
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
            let mut client = FibonacciClient::new(&addr);
            client.compute(10);
        })
    });
    result.assert_success();
    let fib_addr = deploy_address(&[1u8; 32].into(), &FIB_NONCE, &contract_hash);
    result.assert_emitted::<FibComputed>(&fib_addr, |e: &FibComputed| {
        e.input == 10 && e.result == 55
    });
}

#[test]
fn test_fib_multiple_calls_emit_multiple_events() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&FIB_NONCE, &contract_hash);
            let mut client = FibonacciClient::new(&addr);
            client.compute(5);
            client.compute(10);
        })
    });
    result.assert_success();

    let fib_addr = deploy_address(&[1u8; 32].into(), &FIB_NONCE, &contract_hash);
    let events: Vec<FibComputed> = result.filter_events(&fib_addr);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0],
        FibComputed {
            input: 5,
            result: 5
        }
    );
    assert_eq!(
        events[1],
        FibComputed {
            input: 10,
            result: 55
        }
    );
}
