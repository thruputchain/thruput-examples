use error_handling_callee::*;
use error_handling_caller::*;
use sdk::*;

static CALLEE_NONCE: SHA256Hash = sdk::sha256_static!("ERROR_HANDLING_CALLEE_NONCE");
static CALLER_NONCE: SHA256Hash = sdk::sha256_static!("ERROR_HANDLING_CALLER_NONCE");

/// Set up both contracts in a test environment.
fn setup() -> (TestEnvironmentHandle, SHA256Hash, SHA256Hash) {
    let env = TestEnvironment::no_cost();

    let callee_contract = error_handling_callee::test_setup::register(&env);
    let callee_hash = env.setup_create_contract(&callee_contract);

    let caller_contract = error_handling_caller::test_setup::register(&env);
    let caller_hash = env.setup_create_contract(&caller_contract);

    (env, callee_hash, caller_hash)
}

/// Deploy both contracts and return their addresses.
fn deploy_both(
    callee_hash: &SHA256Hash,
    caller_hash: &SHA256Hash,
) -> (ContractAddress, ContractAddress) {
    let callee_addr = deploy_contract(&CALLEE_NONCE, callee_hash);
    let caller_addr = deploy_contract(&CALLER_NONCE, caller_hash);
    (callee_addr, caller_addr)
}

// ── Happy path ────────────────────────────────────────────────────────────

#[test]
fn test_callee_succeeds() {
    let (env, callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let mut client = ErrorHandlingCallerClient::new(&caller_addr);

            assert_eq!(client.call_succeed(&callee_addr, 42), 42);
        })
    });
    result.assert_success();
}

// ── Callee aborts, caller catches ─────────────────────────────────────────

#[test]
fn test_callee_abort_caught() {
    let (env, callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let mut client = ErrorHandlingCallerClient::new(&caller_addr);

            assert!(client.call_and_catch_abort(&callee_addr));
        })
    });
    result.assert_success();
}

// ── Callee faults, caller catches ─────────────────────────────────────────

#[test]
fn test_callee_fault_caught() {
    let (env, callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let mut client = ErrorHandlingCallerClient::new(&caller_addr);

            assert!(client.call_and_catch_fault(&callee_addr));
        })
    });
    result.assert_success();
}

// ── Gas exhaustion caught ─────────────────────────────────────────────────

#[test]
fn test_gas_exhaustion_caught() {
    let (env, callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let mut client = ErrorHandlingCallerClient::new(&caller_addr);

            // Gas limit of 1 is guaranteed too small for 1000 sha256 iterations
            assert!(client.call_with_gas_limit(&callee_addr, 1000, 1));
        })
    });
    result.assert_success();
}
