# Error Handling Cross-Contract Call Examples

Two example contracts (`error_handling_callee` and `error_handling_caller`) demonstrating comprehensive error handling patterns for cross-contract calls. The callee produces various error conditions; the caller invokes the callee (and other targets) and catches every error, so all top-level transactions succeed.

## error_handling_callee

Minimal contract whose methods each produce a different outcome.

**Error type:**
```rust
#[repr(i32)]
pub enum CalleeError {
    Deliberate = 1,
}
```

**Methods:**

| Method | Behavior | Return type |
|--------|----------|-------------|
| `succeed(data: u64)` | Returns the value successfully | `u64` |
| `abort_with_error()` | Calls `abort(&CalleeError::Deliberate)` | never returns |
| `fault()` | Panics to trigger a VM fault | never returns |
| `spin(iterations: u32)` | Loops calling `sha256()` to burn gas | `u32` (iterations completed) |

No events, no state, no dependencies beyond `sdk`. Exists solely to produce error conditions for the caller to handle.

## error_handling_caller

Calls the callee (and other targets) demonstrating each error path. Every method catches errors internally and returns a value, so every top-level transaction succeeds.

**Error type:**
```rust
#[repr(i32)]
pub enum CallerError {
    UnexpectedResult = 1,
}
```

**Dependencies:** `error_handling_callee` (for `ErrorHandlingCalleeClient`), `fibonacci` (for wrong-contract test).

**Methods:**

| Method | Signature | What it demonstrates |
|--------|-----------|---------------------|
| `call_succeed` | `(callee: &ContractAddress, data: u64) -> u64` | Happy path: calls `succeed`, returns the result |
| `call_and_catch_abort` | `(callee: &ContractAddress) -> bool` | Calls `try_abort_with_error()`, catches `CallError::Abort`, extracts `CalleeError::Deliberate`, returns true |
| `call_and_catch_fault` | `(callee: &ContractAddress) -> bool` | Calls `try_fault()`, catches `CallError::Fault`, returns true |
| `call_with_gas_limit` | `(callee: &ContractAddress, iterations: u32, gas_limit: u64) -> bool` | Calls `client.with_gas_limit(gas_limit).try_spin(iterations)`, catches `Fault` from gas exhaustion, returns true |
| `call_nonexistent_address` | `() -> bool` | Constructs `ContractAddress` from arbitrary bytes (nothing deployed), calls `try_succeed` on it, catches the error, returns true |
| `call_wrong_contract` | `(fib_address: &ContractAddress) -> bool` | Points `ErrorHandlingCalleeClient` at a deployed fibonacci contract, calls `try_succeed`, catches the error (wrong contract), returns true |

## Tests

All tests use `TestEnvironment::no_cost()`. Every test calls `result.assert_success()` — the errors are caught within the caller contract, not propagated.

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_callee_succeeds` | Deploy both, call `call_succeed(callee, 42)` | Returns 42 |
| `test_callee_abort_caught` | Deploy both, call `call_and_catch_abort(callee)` | Returns true |
| `test_callee_fault_caught` | Deploy both, call `call_and_catch_fault(callee)` | Returns true |
| `test_gas_exhaustion_caught` | Deploy both, call `call_with_gas_limit(callee, 1000, <small_limit>)` | Returns true |
| `test_nonexistent_address` | Deploy caller only, call `call_nonexistent_address()` | Returns true |
| `test_wrong_contract` | Deploy caller + fibonacci, call `call_wrong_contract(fib_addr)` | Returns true |

## Project structure

```
error-handling-callee/
  Cargo.toml
  src/lib.rs
  tests/test.rs
error-handling-caller/
  Cargo.toml
  src/lib.rs
  tests/test.rs
```

Both added to the workspace `Cargo.toml` members list. Follow the same patterns as the existing `fibonacci` and `cross-call` examples (crate-type `["cdylib", "rlib"]`, `no_std`, `dev` feature, etc.).
