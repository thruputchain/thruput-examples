use cross_call::*;
use fibonacci::*;
use sdk::*;

static FIB_NONCE: SHA256Hash = sdk::sha256_static!("CROSS_CALL_FIB_NONCE");
static CROSS_NONCE: SHA256Hash = sdk::sha256_static!("CROSS_CALL_NONCE");

/// Set up both contracts in a test environment.
/// Returns (env, fib_hash, cross_call_hash).
fn setup() -> (TestEnvironmentHandle, SHA256Hash, SHA256Hash) {
    let env = TestEnvironment::no_cost();

    let fib_contract = env.register_mock(Fibonacci::__mock);
    let fib_hash = env.setup_create_contract(&fib_contract);

    let cross_contract = env.register_mock(CrossCall::__mock);
    let cross_hash = env.setup_create_contract(&cross_contract);

    (env, fib_hash, cross_hash)
}

/// Deploy both contracts and return their addresses.
fn deploy_both(
    fib_hash: &SHA256Hash,
    cross_hash: &SHA256Hash,
) -> (ContractAddress, ContractAddress) {
    let fib_addr = deploy_contract(&FIB_NONCE, fib_hash);
    let cross_addr = deploy_contract(&CROSS_NONCE, cross_hash);
    (fib_addr, cross_addr)
}

// ── Successful cross-contract calls ──────────────────────────────────────

#[test]
fn test_cross_call_fib_succeeds() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);

            assert_eq!(client.call_fib(&fib_addr, 10), 55);
        })
    });
    result.assert_success();
}

#[test]
fn test_cross_call_fib_multiple_values() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);

            assert_eq!(client.call_fib(&fib_addr, 0), 0);
            assert_eq!(client.call_fib(&fib_addr, 1), 1);
            assert_eq!(client.call_fib(&fib_addr, 5), 5);
            assert_eq!(client.call_fib(&fib_addr, 20), 6765);
        })
    });
    result.assert_success();
}

// ── try_* returning Ok ───────────────────────────────────────────────────

#[test]
fn test_try_call_fib_returns_ok() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);

            // call_fib_or_fail uses try_compute internally
            assert_eq!(client.call_fib_or_fail(&fib_addr, 10), 55);
        })
    });
    result.assert_success();
}

// ── Callee throws, caller catches via try_* ──────────────────────────────

#[test]
fn test_callee_error_caught_by_caller() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);

            // call_fib_and_catch_error calls fib with n=999, catches InputTooLarge
            assert!(client.call_fib_and_catch_error(&fib_addr));
        })
    });
    result.assert_success();
}

#[test]
fn test_callee_error_wrapped_by_caller() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);

            // call_fib_or_fail with n=999 should cause fib to throw,
            // which cross-call catches and re-throws as FibCallFailed
            match client.try_call_fib_or_fail(&fib_addr, 999) {
                Err(CrossCallClientError::CrossCallError(CrossCallError::FibCallFailed)) => {}
                other => panic!("Expected CrossCallError::FibCallFailed, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

// ── Event verification ───────────────────────────────────────────────────

#[test]
fn test_cross_call_emits_both_events() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);
            client.call_fib(&fib_addr, 10);
        })
    });
    result.assert_success();

    // call_fib emits FibComputed (from fib contract) then CrossCallCompleted (from cross-call)
    result.assert_event_count(2);
    result.assert_event::<FibComputed>(0, |e| {
        assert_eq!(e.topic(0).unwrap(), FibComputed::SIGNATURE);
        assert_eq!(e.payload().input, 10);
        assert_eq!(e.payload().result, 55);
    });
    result.assert_event::<CrossCallCompleted>(1, |e| {
        assert_eq!(e.topic(0).unwrap(), CrossCallCompleted::SIGNATURE);
        assert_eq!(e.payload().input, 10);
        assert_eq!(e.payload().result, 55);
    });
}

#[test]
fn test_multiple_cross_calls_emit_ordered_events() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);
            client.call_fib(&fib_addr, 5);
            client.call_fib(&fib_addr, 10);
        })
    });
    result.assert_success();

    // Each call_fib emits FibComputed + CrossCallCompleted, so 4 events total:
    // [0] FibComputed(5, 5), [1] CrossCallCompleted(5, 5),
    // [2] FibComputed(10, 55), [3] CrossCallCompleted(10, 55)
    result.assert_event_count(4);

    result.assert_event::<FibComputed>(0, |e| {
        assert_eq!(e.payload().input, 5);
        assert_eq!(e.payload().result, 5);
    });
    result.assert_event::<CrossCallCompleted>(1, |e| {
        assert_eq!(e.payload().input, 5);
        assert_eq!(e.payload().result, 5);
    });
    result.assert_event::<FibComputed>(2, |e| {
        assert_eq!(e.payload().input, 10);
        assert_eq!(e.payload().result, 55);
    });
    result.assert_event::<CrossCallCompleted>(3, |e| {
        assert_eq!(e.payload().input, 10);
        assert_eq!(e.payload().result, 55);
    });
}

// ── client_test shorthand ────────────────────────────────────────────────

#[test]
fn test_client_test_shorthand() {
    // Demonstrates the simpler client_test API for quick single-contract tests.
    // This doesn't give TransactResult (no event access), but is more concise.
    sdk::client_test(
        |env| env.register_mock(Fibonacci::__mock),
        |client: &mut FibonacciClient| {
            assert_eq!(client.compute(10), 55);
        },
    );
}
