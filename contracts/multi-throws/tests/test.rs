use multi_throws::*;
use thruput_sdk::*;

static NONCE_1: SHA256Hash = thruput_sdk::sha256_static!("MULTI_THROWS_1");
static NONCE_2: SHA256Hash = thruput_sdk::sha256_static!("MULTI_THROWS_2");

/// Helper: register the contract and return the environment and hash.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();

    let contract = multi_throws::register_mock_contract(&env);
    (env, *contract.as_hash())
}

// ── Success path ─────────────────────────────────────────────────────────

#[test]
fn test_succeed() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            assert_eq!(client.succeed(), 42);
            assert_eq!(client.try_succeed(), Ok(42));
        })
    });
    result.assert_success();
}

// ── Declared error types match directly ──────────────────────────────────
// `try_as` is the shorthand when only one exception type is of interest.

#[test]
fn test_throw_alpha_not_found() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            let err = client.try_throw_alpha_not_found().unwrap_err();
            assert_eq!(err.try_as(), Some(AlphaError::NotFound));
        })
    });
    result.assert_success();
}

#[test]
fn test_throw_alpha_overflow() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            let err = client.try_throw_alpha_overflow().unwrap_err();
            assert_eq!(err.try_as(), Some(AlphaError::Overflow));
        })
    });
    result.assert_success();
}

#[test]
fn test_throw_beta_denied() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            let err = client.try_throw_beta_denied().unwrap_err();
            assert_eq!(err.try_as(), Some(BetaError::Denied));
        })
    });
    result.assert_success();
}

// ── Undeclared errors are caught the same way ────────────────────────────
// An exception identifies its own type by selector, so an error the
// interface never declared is decoded exactly like a declared one.

#[test]
fn test_throw_undeclared_is_still_decodable() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            // SecretError is not in the throws list. The caller decodes it
            // anyway, because the selector on the wire names the type.
            let err = client.try_throw_undeclared().unwrap_err();
            assert_eq!(err.try_as::<SecretError>(), Some(SecretError::Secret));
        })
    });
    result.assert_success();
}

// ── Error forwarding through call chains ─────────────────────────────────
// Non-try method calls forward errors automatically. Declared errors
// preserve their type; undeclared errors preserve their selector.

#[test]
fn test_forward_declared_error() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr1 = deploy_contract(&NONCE_1, &contract_hash);
            let addr2 = deploy_contract(&NONCE_2, &contract_hash);
            let client = MultiThrowsClient::new(&addr1);

            // addr1 calls throw_alpha_not_found on addr2 via non-try method.
            // The error is forwarded through the call chain.
            let err = client.try_forward_error(addr2).unwrap_err();
            assert_eq!(err.try_as(), Some(AlphaError::NotFound));
        })
    });
    result.assert_success();
}

#[test]
fn test_forward_undeclared_error() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr1 = deploy_contract(&NONCE_1, &contract_hash);
            let addr2 = deploy_contract(&NONCE_2, &contract_hash);
            let client = MultiThrowsClient::new(&addr1);

            // addr1 calls throw_undeclared on addr2. SecretError is forwarded
            // as raw bytes, keeping its original selector.
            let err = client.try_forward_undeclared(addr2).unwrap_err();
            assert_eq!(err.try_as::<SecretError>(), Some(SecretError::Secret));
        })
    });
    result.assert_success();
}

// ── Fault propagation ────────────────────────────────────────────────────
// Panics become Fault errors. They propagate through call chains.

#[test]
fn test_panics_becomes_fault() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            // A panic in the contract becomes a Fault error
            match client.try_panics() {
                Err(CallError::Fault(_)) => {}
                other => panic!("Expected Fault, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_forward_fault() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr1 = deploy_contract(&NONCE_1, &contract_hash);
            let addr2 = deploy_contract(&NONCE_2, &contract_hash);
            let client = MultiThrowsClient::new(&addr1);

            // addr1 calls panics() on addr2 via non-try method.
            // The fault propagates through the call chain.
            match client.try_forward_fault(addr2) {
                Err(CallError::Fault(_)) => {}
                other => panic!("Expected forwarded Fault, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

// ── Guest-side catching with match_exn! ──────────────────────────────────
// `classify` runs the whole dispatch inside the contract, which is where a
// real caller does it. One `match_exn!` covers the interface's declared
// errors, one it never declared, and an SDK exception, side by side.

#[test]
fn test_classify_dispatches_every_outcome_in_guest_code() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let caller = deploy_contract(&NONCE_1, &contract_hash);
            let target = deploy_contract(&NONCE_2, &contract_hash);
            let client = MultiThrowsClient::new(&caller);

            assert_eq!(client.classify(target, 0), 0, "success");
            assert_eq!(client.classify(target, 1), 2, "AlphaError::NotFound");
            assert_eq!(client.classify(target, 2), 3, "AlphaError::Overflow");
            assert_eq!(client.classify(target, 3), 4, "BetaError::Denied");
            assert_eq!(client.classify(target, 4), 5, "SecretError (undeclared)");
            assert_eq!(client.classify(target, 5), 6, "LibraryExn");
        })
    });
    result.assert_success();
}
