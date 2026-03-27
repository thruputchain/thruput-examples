use multi_throws::*;
use sdk::*;

static NONCE_1: SHA256Hash = sdk::sha256_static!("MULTI_THROWS_1");
static NONCE_2: SHA256Hash = sdk::sha256_static!("MULTI_THROWS_2");

/// Helper: register the contract and return the environment and hash.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = env.register_mock(<MultiThrowsContract as MultiThrows>::__mock);
    let contract_hash = env.setup_create_contract(&contract);
    (env, contract_hash)
}

// ── Success path ─────────────────────────────────────────────────────────

#[test]
fn test_succeed() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr);

            assert_eq!(client.succeed(), 42);
            assert_eq!(client.try_succeed(), Ok(42));
        })
    });
    result.assert_success();
}

// ── Declared error types match directly ──────────────────────────────────
// Each declared error type gets its own variant in MultiThrowsClientError,
// so you can pattern-match without the old as_contract_exn() dance.

#[test]
fn test_throw_alpha_not_found() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr);

            match client.try_throw_alpha_not_found() {
                Err(MultiThrowsClientError::AlphaError(AlphaError::NotFound)) => {}
                other => panic!("Expected AlphaError::NotFound, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_throw_alpha_overflow() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr);

            match client.try_throw_alpha_overflow() {
                Err(MultiThrowsClientError::AlphaError(AlphaError::Overflow)) => {}
                other => panic!("Expected AlphaError::Overflow, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_throw_beta_denied() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr);

            match client.try_throw_beta_denied() {
                Err(MultiThrowsClientError::BetaError(BetaError::Denied)) => {}
                other => panic!("Expected BetaError::Denied, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

// ── Undeclared errors arrive as Unknown ──────────────────────────────────
// Errors not listed in throws() land in the Unknown variant. If you know
// the type, you can decode it with try_as.

#[test]
fn test_throw_undeclared_arrives_as_unknown() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr);

            // SecretError is not in the throws list, so it arrives as Unknown.
            // The caller can still decode it with try_as if it knows the type.
            match client.try_throw_undeclared() {
                Err(MultiThrowsClientError::Unknown(ref raw)) => {
                    let secret = raw.try_as::<SecretError>();
                    assert_eq!(secret, Some(SecretError::Secret));
                }
                other => panic!("Expected Unknown(SecretError), got: {:?}", other),
            }
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
        tx.call(&[1u8; 32].into()).run(|| {
            let addr1 = deploy_contract(&NONCE_1, &contract_hash);
            let addr2 = deploy_contract(&NONCE_2, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr1);

            // addr1 calls throw_alpha_not_found on addr2 via non-try method.
            // The error is forwarded through the call chain.
            match client.try_forward_error(addr2) {
                Err(MultiThrowsClientError::AlphaError(AlphaError::NotFound)) => {}
                other => panic!("Expected forwarded AlphaError::NotFound, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_forward_undeclared_error() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr1 = deploy_contract(&NONCE_1, &contract_hash);
            let addr2 = deploy_contract(&NONCE_2, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr1);

            // addr1 calls throw_undeclared on addr2. SecretError is forwarded
            // as raw bytes and arrives as Unknown with the original selector.
            match client.try_forward_undeclared(addr2) {
                Err(MultiThrowsClientError::Unknown(ref raw)) => {
                    let secret = raw.try_as::<SecretError>();
                    assert_eq!(secret, Some(SecretError::Secret));
                }
                other => panic!("Expected forwarded Unknown(SecretError), got: {:?}", other),
            }
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
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&NONCE_1, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr);

            // A panic in the contract becomes a Fault error
            match client.try_panics() {
                Err(MultiThrowsClientError::Fault(_)) => {}
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
        tx.call(&[1u8; 32].into()).run(|| {
            let addr1 = deploy_contract(&NONCE_1, &contract_hash);
            let addr2 = deploy_contract(&NONCE_2, &contract_hash);
            let mut client = MultiThrowsClient::new(&addr1);

            // addr1 calls panics() on addr2 via non-try method.
            // The fault propagates through the call chain.
            match client.try_forward_fault(addr2) {
                Err(MultiThrowsClientError::Fault(_)) => {}
                other => panic!("Expected forwarded Fault, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}
