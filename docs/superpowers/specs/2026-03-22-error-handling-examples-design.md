# Error Handling Cross-Contract Call Examples

Two example contracts (`error_handling_callee` and `error_handling_caller`) demonstrating comprehensive error handling patterns for cross-contract calls. The callee produces various error conditions; the caller invokes the callee (and other targets) and catches every error, so all top-level transactions succeed.

## error_handling_callee

Minimal contract whose methods each produce a different outcome.

**Error type:**
```rust
#[derive(Error, Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
#[repr(i32)]
pub enum CalleeError {
    #[error("Deliberate error")]
    Deliberate = 1,
}
```

**Methods:**

| Method | Behavior | Return type |
|--------|----------|-------------|
| `succeed(data: u64)` | Returns the value successfully | `u64` |
| `abort_with_error()` | Calls `abort(&CalleeError::Deliberate)` | never returns |
| `fault()` | Calls `panic!("deliberate fault")` to trigger a VM fault | never returns |
| `spin(iterations: u32)` | Loops calling `sha256()` to burn gas | `u32` (iterations completed) |

No events, no state, no dependencies beyond `sdk`. Exists solely to produce error conditions for the caller to handle.

**Standalone tests** (in `error-handling-callee/tests/test.rs`, paralleling `fibonacci`'s own tests):
- `test_succeed` — calls `succeed(42)`, asserts returns 42
- `test_abort_with_error` — calls `try_abort_with_error()`, asserts `CallError::Abort` with `CalleeError::Deliberate`
- `test_fault` — calls `try_fault()`, asserts `CallError::Fault`
- `test_spin_completes` — calls `spin(10)` with sufficient gas, asserts returns 10

## error_handling_caller

Calls the callee (and other targets) demonstrating each error path. Every method catches errors internally and returns a value, so every top-level transaction succeeds.

**Error type:** The `#[contract]` macro requires a `throws` type. Since the caller never aborts (it catches everything), `CallerError` exists only to satisfy the macro:
```rust
#[derive(Error, Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
#[repr(i32)]
pub enum CallerError {
    #[error("Unexpected result")]
    UnexpectedResult = 1,
}
```

**Dependencies:** `error_handling_callee` (for `ErrorHandlingCalleeClient`), `fibonacci` (for wrong-contract test). Both as path dependencies, same pattern as `cross-call` depending on `fibonacci`.

**Methods:**

| Method | Signature | What it demonstrates |
|--------|-----------|---------------------|
| `call_succeed` | `(callee: &ContractAddress, data: u64) -> u64` | Happy path: calls `succeed`, returns the result |
| `call_and_catch_abort` | `(callee: &ContractAddress) -> bool` | Calls `try_abort_with_error()`, catches `CallError::Abort`, extracts `CalleeError::Deliberate`, returns true |
| `call_and_catch_fault` | `(callee: &ContractAddress) -> bool` | Calls `try_fault()`, catches `CallError::Fault`, returns true |
| `call_with_gas_limit` | `(callee: &ContractAddress, iterations: u32, gas_limit: u64) -> bool` | Calls `client.with_gas_limit(gas_limit).try_spin(iterations)`, catches `CallError::Fault` from gas exhaustion, returns true |
| `call_nonexistent_address` | `() -> bool` | Constructs `ContractAddress` from arbitrary bytes (nothing deployed), calls `try_succeed` on it, catches the error (expected: `CallError::Fault`), returns true |
| `call_wrong_contract` | `(fib_address: &ContractAddress) -> bool` | Points `ErrorHandlingCalleeClient` at a deployed fibonacci contract, calls `try_succeed`, catches the error (expected: `CallError::Fault`), returns true |

Note: `call_nonexistent_address` and `call_wrong_contract` both expect `CallError::Fault` since there is no valid callee to produce a typed `Abort`. The caller should match on `Err(_)` broadly or specifically on `Fault` — either way the error is caught and `true` is returned.

## Tests (caller)

All tests use `TestEnvironment::no_cost()`. Every test calls `result.assert_success()` — the errors are caught within the caller contract, not propagated.

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_callee_succeeds` | Deploy both, call `call_succeed(callee, 42)` | Returns 42 |
| `test_callee_abort_caught` | Deploy both, call `call_and_catch_abort(callee)` | Returns true |
| `test_callee_fault_caught` | Deploy both, call `call_and_catch_fault(callee)` | Returns true |
| `test_gas_exhaustion_caught` | Deploy both, call `call_with_gas_limit(callee, 1000, 1)` with gas limit of 1 (guaranteed too small) | Returns true |
| `test_nonexistent_address` | Deploy caller only, call `call_nonexistent_address()` | Returns true |
| `test_wrong_contract` | Deploy caller + fibonacci, call `call_wrong_contract(fib_addr)` | Returns true |

## Project structure

```
error-handling-callee/
  Cargo.toml          # deps: sdk, xdrs, thiserror
  src/lib.rs
  tests/test.rs
error-handling-caller/
  Cargo.toml          # deps: sdk, xdrs, thiserror, error-handling-callee, fibonacci
  src/lib.rs
  tests/test.rs
```

Both added to the workspace `Cargo.toml` members list. Follow the same conventions as existing examples: `#![cfg_attr(not(feature = "dev"), no_std)]`, crate-type `["cdylib", "rlib"]`, `dev` feature gating, `doctest = false`, `test = false` in `[lib]`.
