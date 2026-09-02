use multi_throws::*;
use sdk::*;

static NONCE_1: SHA256Hash = sdk::sha256_static!("MULTI_THROWS_1");
static NONCE_2: SHA256Hash = sdk::sha256_static!("MULTI_THROWS_2");

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
// A declared error is matched by naming its type in a `match_exn!` arm.
// `try_as` is the shorthand when only one type is of interest.

#[test]
fn test_throw_alpha_not_found() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            assert_eq!(
                client.try_throw_alpha_not_found().unwrap_err().try_as(),
                Some(AlphaError::NotFound),
            );
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

            assert_eq!(
                client.try_throw_alpha_overflow().unwrap_err().try_as(),
                Some(AlphaError::Overflow),
            );
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

            assert_eq!(
                client.try_throw_beta_denied().unwrap_err().try_as(),
                Some(BetaError::Denied),
            );
        })
    });
    result.assert_success();
}

// ── Undeclared errors are matched the same way ───────────────────────────
// An error absent from throws() needs nothing special: the selector
// identifies its type either way, so it is a peer of the declared ones.

#[test]
fn test_throw_undeclared_arrives_as_unknown() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let client = MultiThrowsClient::new(&addr);

            // SecretError is not in the throws list, and needs no detour:
            // a `match_exn!` arm names it exactly like a declared error.
            let err = client.try_throw_undeclared().unwrap_err();
            assert!(match_exn!(err, {
                SecretError::Secret => true,
                AlphaError::NotFound | AlphaError::Overflow => false,
                BetaError::Denied => false,
                _ => false,
            }));
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
            assert_eq!(
                client.try_forward_error(addr2).unwrap_err().try_as(),
                Some(AlphaError::NotFound),
            );
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

            // addr1 calls throw_undeclared on addr2. SecretError is
            // forwarded verbatim, so its selector survives both hops.
            assert_eq!(
                client.try_forward_undeclared(addr2).unwrap_err().try_as(),
                Some(SecretError::Secret),
            );
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
            // A fault carries no exception, so it stays an ordinary
            // `match` on `CallError`.
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
