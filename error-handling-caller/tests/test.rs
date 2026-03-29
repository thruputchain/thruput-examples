use error_handling_callee::ErrorHandlingCallee;
use error_handling_caller::*;
use fibonacci::Fibonacci;
use sdk::*;

static CALLEE_NONCE: SHA256Hash = sdk::sha256_static!("ERROR_HANDLING_CALLEE_NONCE");
static CALLER_NONCE: SHA256Hash = sdk::sha256_static!("ERROR_HANDLING_CALLER_NONCE");
static FIB_NONCE: SHA256Hash = sdk::sha256_static!("ERROR_HANDLING_FIB_NONCE");

/// Set up both contracts in a test environment.
fn setup() -> (TestEnvironmentHandle, SHA256Hash, SHA256Hash) {
    let env = TestEnvironment::no_cost();

    let callee_contract = env.register_mock(ErrorHandlingCallee::__mock);
    let callee_hash = env.setup_create_contract(&callee_contract);

    let caller_contract = env.register_mock(ErrorHandlingCaller::__mock);
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
        tx.call(&ContractAddress::named("caller")).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let client = ErrorHandlingCallerClient::new(&caller_addr);

            assert_eq!(client.call_succeed(&callee_addr, 42), 42);
        })
    });
    result.assert_success();
}

// ── Callee throws, caller catches ─────────────────────────────────────────

#[test]
fn test_callee_error_caught() {
    let (env, callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let client = ErrorHandlingCallerClient::new(&caller_addr);

            assert!(client.call_and_catch_error(&callee_addr));
        })
    });
    result.assert_success();
}

// ── Callee faults, caller catches ─────────────────────────────────────────

#[test]
fn test_callee_fault_caught() {
    let (env, callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let client = ErrorHandlingCallerClient::new(&caller_addr);

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
        tx.call(&ContractAddress::named("caller")).run(|| {
            let (callee_addr, caller_addr) = deploy_both(&callee_hash, &caller_hash);
            let client = ErrorHandlingCallerClient::new(&caller_addr);

            // Gas limit of 1 is guaranteed too small for 1000 sha256 iterations
            assert!(client.call_with_gas_limit(&callee_addr, 1000, 1));
        })
    });
    result.assert_success();
}

// ── Nonexistent address ───────────────────────────────────────────────────

#[test]
fn test_nonexistent_address() {
    let (env, _callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let caller_addr = deploy_contract(&CALLER_NONCE, &caller_hash);
            let client = ErrorHandlingCallerClient::new(&caller_addr);

            assert!(client.call_nonexistent_address());
        })
    });
    result.assert_success();
}

// ── Wrong contract (fibonacci instead of callee) ──────────────────────────

#[test]
fn test_wrong_contract() {
    let env = TestEnvironment::no_cost();

    let fib_contract = env.register_mock(Fibonacci::__mock);
    let fib_hash = env.setup_create_contract(&fib_contract);

    let caller_contract = env.register_mock(ErrorHandlingCaller::__mock);
    let caller_hash = env.setup_create_contract(&caller_contract);

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let fib_addr = deploy_contract(&FIB_NONCE, &fib_hash);
            let caller_addr = deploy_contract(&CALLER_NONCE, &caller_hash);
            let client = ErrorHandlingCallerClient::new(&caller_addr);

            assert!(client.call_wrong_contract(&fib_addr));
        })
    });
    result.assert_success();
}
