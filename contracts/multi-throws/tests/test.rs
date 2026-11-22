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

// ── Error forwarding through call chains ─────────────────────────────────
// Non-try method calls forward errors automatically, and keep their type.

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

// ── Guest-side catching with match_exn! ──────────────────────────────────
// `classify` runs the whole dispatch inside the contract, which is where a
// real caller does it. One `match_exn!` covers both declared error types
// and an SDK exception, side by side.

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
            assert_eq!(client.classify(target, 4), 5, "LibraryExn");
        })
    });
    result.assert_success();
}
