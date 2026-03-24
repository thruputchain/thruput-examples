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

// ── Callee aborts, caller catches via try_* ──────────────────────────────

#[test]
fn test_callee_abort_caught_by_caller() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);

            // call_fib_and_catch_abort calls fib with n=999, catches InputTooLarge
            assert!(client.call_fib_and_catch_abort(&fib_addr));
        })
    });
    result.assert_success();
}

#[test]
fn test_callee_abort_wrapped_by_caller() {
    let (env, fib_hash, cross_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (fib_addr, cross_addr) = deploy_both(&fib_hash, &cross_hash);
            let mut client = CrossCallClient::new(&cross_addr);

            // call_fib_or_fail with n=999 should cause fib to abort,
            // which cross-call catches and re-aborts as FibCallFailed
            match client.try_call_fib_or_fail(&fib_addr, 999) {
                Err(CallError::Abort(ref cross_exn)) => {
                    let err = cross_exn
                        .as_contract_exn()
                        .expect("expected CrossCallError");
                    assert_eq!(*err, CrossCallError::FibCallFailed);
                }
                other => panic!("Expected FibCallFailed abort, got: {:?}", other),
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

    // The fibonacci contract emits FibComputed from the fib address,
    // the cross-call contract emits CrossCallCompleted from the cross-call address.
    // deploy_address computes the deterministic address from deployer + nonce + hash.
    let fib_addr = deploy_address(&[1u8; 32].into(), &FIB_NONCE, &fib_hash);
    let cross_addr = deploy_address(&[1u8; 32].into(), &CROSS_NONCE, &cross_hash);
    result.assert_emitted::<FibComputed>(&fib_addr, |e: &FibComputed| {
        e.input == 10 && e.result == 55
    });
    result.assert_emitted::<CrossCallCompleted>(&cross_addr, |e: &CrossCallCompleted| {
        e.input == 10 && e.result == 55
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

    // We need the deployed addresses to filter events by contract
    let fib_addr = deploy_address(&[1u8; 32].into(), &FIB_NONCE, &fib_hash);
    let cross_addr = deploy_address(&[1u8; 32].into(), &CROSS_NONCE, &cross_hash);

    // Each call_fib emits a FibComputed (from fib) + CrossCallCompleted (from cross-call)
    let fib_events: Vec<FibComputed> = result.filter_events(&fib_addr);
    assert_eq!(fib_events.len(), 2);
    assert_eq!(
        fib_events[0],
        FibComputed {
            input: 5,
            result: 5
        }
    );
    assert_eq!(
        fib_events[1],
        FibComputed {
            input: 10,
            result: 55
        }
    );

    let cross_events: Vec<CrossCallCompleted> = result.filter_events(&cross_addr);
    assert_eq!(cross_events.len(), 2);
    assert_eq!(
        cross_events[0],
        CrossCallCompleted {
            input: 5,
            result: 5
        }
    );
    assert_eq!(
        cross_events[1],
        CrossCallCompleted {
            input: 10,
            result: 55
        }
    );
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
