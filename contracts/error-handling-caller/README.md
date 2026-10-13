# Error-handling caller: handle a failed call

Learn to distinguish a successful return, a contract exception, a fault, and a
call to the wrong target. The companion callee deliberately produces failures.

## Run

Complete the [Rust setup](../../docs/getting-started.md#1-rust-and-registry-access)
and read [the callee](../error-handling-callee/README.md). From the repo root:

```sh
cargo test -p error-handling-caller --locked
```

Expected: **6 tests pass**, including fault, gas exhaustion, and wrong-target
cases. The tests register their dependencies; no running node is needed.

## Read

1. [Contract](src/lib.rs): handling of the callee's outcomes.
2. [Tests](tests/test.rs): which outcomes are caught and how they are asserted.

Native tests unwind panics. Guest execution has abort semantics; do not infer
all guest behavior from native tests alone. See [test categories](../../docs/development.md#rust-test-categories).

## Try a change

Add a second successful call with a different value, then compare its result
with the wrong-contract test. Identify which layer reports each failure.

Next: [Multi-throws](../multi-throws/README.md).
