# Error Handling Cross-Contract Call Examples — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two example contracts demonstrating comprehensive error handling for cross-contract calls — a callee that produces various error conditions, and a caller that catches every one.

**Architecture:** The callee (`error_handling_callee`) has four methods: succeed, abort, fault, and spin (burn gas). The caller (`error_handling_caller`) invokes these plus a nonexistent address and a wrong contract (fibonacci), catching all errors so every top-level transaction succeeds.

**Tech Stack:** Rust, groundhog SDK 0.5.3, xdrs, thiserror, `no_std`

**Spec:** `docs/superpowers/specs/2026-03-22-error-handling-examples-design.md`

---

### Task 1: Scaffold and implement error-handling-callee

**Files:**
- Create: `error-handling-callee/Cargo.toml`
- Create: `error-handling-callee/src/lib.rs`
- Create: `error-handling-callee/tests/test.rs`
- Modify: `Cargo.toml` (workspace members)

- [ ] **Step 1: Create `error-handling-callee/Cargo.toml`**

```toml
[package]
name = "error-handling-callee"
description = "Example contract producing various error conditions for cross-contract call testing"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[features]
dev = ["sdk/dev"]

[lib]
crate-type = ["cdylib", "rlib"]
doctest = false
test = false

[dependencies]
sdk = { workspace = true, features = ["debugging"] }
xdrs = { workspace = true }
thiserror = { workspace = true }

[dev-dependencies]
error-handling-callee = { path = ".", features = ["dev"] }
```

- [ ] **Step 2: Create `error-handling-callee/src/lib.rs`**

```rust
#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::*;
use thiserror::Error;

/// Error type for the callee contract.
#[derive(Error, Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
#[repr(i32)]
pub enum CalleeError {
    #[error("Deliberate error")]
    Deliberate = 1,
}

/// Stateless contract that produces various error conditions.
pub struct ErrorHandlingCallee;

#[contract(throws = CalleeError, client = ErrorHandlingCalleeClient)]
impl ErrorHandlingCallee {
    /// Return the input value successfully.
    pub fn succeed(data: u64) -> u64 {
        data
    }

    /// Abort with a typed error.
    pub fn abort_with_error() -> u64 {
        abort(&CalleeError::Deliberate);
    }

    /// Panic to trigger a VM fault.
    pub fn fault() -> u64 {
        panic!("deliberate fault");
    }

    /// Burn gas by repeatedly hashing. Returns the iteration count if it completes.
    pub fn spin(iterations: u32) -> u32 {
        let mut hash = sha256(b"seed");
        for _ in 1..iterations {
            hash = sha256(&hash);
        }
        // Use hash to prevent the loop from being optimized away
        let _ = hash;
        iterations
    }
}
```

- [ ] **Step 3: Add `error-handling-callee` to workspace `Cargo.toml`**

Change the members line in the root `Cargo.toml`:

```toml
members = ["fibonacci", "cross-call", "error-handling-callee"]
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p error-handling-callee`
Expected: Compiles successfully.

- [ ] **Step 5: Write callee tests in `error-handling-callee/tests/test.rs`**

```rust
use error_handling_callee::*;
use sdk::*;

static CALLEE_NONCE: SHA256Hash = sdk::sha256_static!("CALLEE_TEST_NONCE");

/// Helper: set up the callee contract in a test environment.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let test_contract = test_setup::register(&env);
    let contract_hash = env.setup_create_contract(&test_contract);
    (env, contract_hash)
}

#[test]
fn test_succeed() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            assert_eq!(client.succeed(42), 42);
            assert_eq!(client.succeed(0), 0);
        })
    });
    result.assert_success();
}

#[test]
fn test_abort_with_error() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            match client.try_abort_with_error() {
                Err(CallError::Abort(ref cross_exn)) => {
                    let err = cross_exn.as_contract_exn().expect("expected CalleeError");
                    assert_eq!(*err, CalleeError::Deliberate);
                }
                other => panic!("Expected abort with Deliberate, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_fault() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            match client.try_fault() {
                Err(CallError::Fault(_)) => {} // expected
                other => panic!("Expected Fault, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_spin_completes() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CALLEE_NONCE, &contract_hash);
            let mut client = ErrorHandlingCalleeClient::new(&addr);

            assert_eq!(client.spin(10), 10);
        })
    });
    result.assert_success();
}
```

- [ ] **Step 6: Run callee tests**

Run: `cargo test -p error-handling-callee`
Expected: All 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add error-handling-callee/ Cargo.toml Cargo.lock
git commit -m "Add error-handling-callee contract with tests"
```

---

### Task 2: Scaffold error-handling-caller and implement happy path + abort catching

**Files:**
- Create: `error-handling-caller/Cargo.toml`
- Create: `error-handling-caller/src/lib.rs`
- Create: `error-handling-caller/tests/test.rs`
- Modify: `Cargo.toml` (workspace members)

- [ ] **Step 1: Create `error-handling-caller/Cargo.toml`**

```toml
[package]
name = "error-handling-caller"
description = "Example contract demonstrating comprehensive cross-contract error handling"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[features]
dev = ["sdk/dev", "error-handling-callee/dev", "fibonacci/dev"]

[lib]
crate-type = ["cdylib", "rlib"]
doctest = false
test = false

[dependencies]
sdk = { workspace = true, features = ["debugging"] }
error-handling-callee = { path = "../error-handling-callee" }
fibonacci = { path = "../fibonacci" }
xdrs = { workspace = true }
thiserror = { workspace = true }

[dev-dependencies]
error-handling-caller = { path = ".", features = ["dev"] }
```

- [ ] **Step 2: Create `error-handling-caller/src/lib.rs` with first two methods**

```rust
#![cfg_attr(not(feature = "dev"), no_std)]

use error_handling_callee::{CalleeError, ErrorHandlingCalleeClient};
use sdk::*;
use thiserror::Error;

/// Error type for the caller contract. Exists to satisfy the #[contract] macro;
/// the caller never aborts — it catches everything.
#[derive(Error, Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
#[repr(i32)]
pub enum CallerError {
    #[error("Unexpected result")]
    UnexpectedResult = 1,
}

/// Contract demonstrating comprehensive cross-contract error handling.
pub struct ErrorHandlingCaller;

#[contract(throws = CallerError, client = ErrorHandlingCallerClient)]
impl ErrorHandlingCaller {
    /// Happy path: call succeed on the callee, return the result.
    pub fn call_succeed(callee: &ContractAddress, data: u64) -> u64 {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        client.succeed(data)
    }

    /// Call the callee's abort_with_error, catch the Abort, verify it contains
    /// CalleeError::Deliberate, and return true.
    pub fn call_and_catch_abort(callee: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        match client.try_abort_with_error() {
            Err(CallError::Abort(ref cross_exn)) => cross_exn
                .as_contract_exn()
                .is_some_and(|e| *e == CalleeError::Deliberate),
            _ => false,
        }
    }
}
```

- [ ] **Step 3: Add `error-handling-caller` to workspace `Cargo.toml`**

Change the members line in the root `Cargo.toml`:

```toml
members = ["fibonacci", "cross-call", "error-handling-callee", "error-handling-caller"]
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p error-handling-caller`
Expected: Compiles successfully.

- [ ] **Step 5: Write initial caller tests in `error-handling-caller/tests/test.rs`**

```rust
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
```

- [ ] **Step 6: Run caller tests**

Run: `cargo test -p error-handling-caller`
Expected: Both tests pass.

- [ ] **Step 7: Commit**

```bash
git add error-handling-caller/ Cargo.toml Cargo.lock
git commit -m "Add error-handling-caller with happy path and abort catching"
```

---

### Task 3: Add fault catching and gas limit methods to caller

**Files:**
- Modify: `error-handling-caller/src/lib.rs`
- Modify: `error-handling-caller/tests/test.rs`

- [ ] **Step 1: Add `call_and_catch_fault` and `call_with_gas_limit` to `error-handling-caller/src/lib.rs`**

Add these methods inside the `#[contract]` impl block, after `call_and_catch_abort`:

```rust
    /// Call the callee's fault method, catch the Fault, and return true.
    pub fn call_and_catch_fault(callee: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        match client.try_fault() {
            Err(CallError::Fault(_)) => true,
            _ => false,
        }
    }

    /// Call the callee's spin method with a gas limit. If the callee runs out of gas,
    /// catch the Fault and return true.
    pub fn call_with_gas_limit(callee: &ContractAddress, iterations: u32, gas_limit: u64) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        match client.with_gas_limit(gas_limit).try_spin(iterations) {
            Err(CallError::Fault(_)) => true,
            _ => false,
        }
    }
```

- [ ] **Step 2: Add tests for fault and gas limit to `error-handling-caller/tests/test.rs`**

Append after the existing tests:

```rust
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
```

- [ ] **Step 3: Run all caller tests**

Run: `cargo test -p error-handling-caller`
Expected: All 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add error-handling-caller/
git commit -m "Add fault catching and gas limit error handling to caller"
```

---

### Task 4: Add nonexistent address and wrong contract methods to caller

**Files:**
- Modify: `error-handling-caller/src/lib.rs`
- Modify: `error-handling-caller/tests/test.rs`

- [ ] **Step 1: Add `call_nonexistent_address` and `call_wrong_contract` to `error-handling-caller/src/lib.rs`**

Add these methods inside the `#[contract]` impl block, after `call_with_gas_limit`. No new imports needed in `lib.rs` — both methods only use `ErrorHandlingCalleeClient` and `ContractAddress` which are already in scope. The `fibonacci` dependency in `Cargo.toml` is only needed for the `dev` feature gate so tests can deploy fibonacci.

```rust
    /// Call try_succeed on an address where no contract is deployed.
    /// Catches the resulting error and returns true.
    pub fn call_nonexistent_address() -> bool {
        // Arbitrary address with no contract deployed
        let fake_addr: ContractAddress = [0xFFu8; 32].into();
        let mut client = ErrorHandlingCalleeClient::new(&fake_addr);
        match client.try_succeed(42) {
            Err(_) => true,
            Ok(_) => false,
        }
    }

    /// Point an ErrorHandlingCalleeClient at a fibonacci contract and call try_succeed.
    /// The fibonacci contract doesn't have a `succeed` method, so this should fail.
    /// Catches the resulting error and returns true.
    pub fn call_wrong_contract(fib_address: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(fib_address);
        match client.try_succeed(42) {
            Err(_) => true,
            Ok(_) => false,
        }
    }
```

- [ ] **Step 2: Add tests for nonexistent address and wrong contract to `error-handling-caller/tests/test.rs`**

Add the fibonacci import at the top:

```rust
use fibonacci::*;
```

Add a nonce for fibonacci:

```rust
static FIB_NONCE: SHA256Hash = sdk::sha256_static!("ERROR_HANDLING_FIB_NONCE");
```

Append the tests:

```rust
// ── Nonexistent address ───────────────────────────────────────────────────

#[test]
fn test_nonexistent_address() {
    let (env, _callee_hash, caller_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let caller_addr = deploy_contract(&CALLER_NONCE, &caller_hash);
            let mut client = ErrorHandlingCallerClient::new(&caller_addr);

            assert!(client.call_nonexistent_address());
        })
    });
    result.assert_success();
}

// ── Wrong contract (fibonacci instead of callee) ──────────────────────────

#[test]
fn test_wrong_contract() {
    let env = TestEnvironment::no_cost();

    let fib_contract = fibonacci::test_setup::register(&env);
    let fib_hash = env.setup_create_contract(&fib_contract);

    let caller_contract = error_handling_caller::test_setup::register(&env);
    let caller_hash = env.setup_create_contract(&caller_contract);

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let fib_addr = deploy_contract(&FIB_NONCE, &fib_hash);
            let caller_addr = deploy_contract(&CALLER_NONCE, &caller_hash);
            let mut client = ErrorHandlingCallerClient::new(&caller_addr);

            assert!(client.call_wrong_contract(&fib_addr));
        })
    });
    result.assert_success();
}
```

- [ ] **Step 3: Run all caller tests**

Run: `cargo test -p error-handling-caller`
Expected: All 6 tests pass.

- [ ] **Step 4: Run the full workspace test suite**

Run: `cargo test --workspace`
Expected: All tests across all 4 crates pass (fibonacci, cross-call, error-handling-callee, error-handling-caller).

- [ ] **Step 5: Commit**

```bash
git add error-handling-caller/ Cargo.lock
git commit -m "Add nonexistent address and wrong contract error handling to caller"
```
