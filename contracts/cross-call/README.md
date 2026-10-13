# Cross-call: call another contract

Learn to use a generated client inside a contract. This contract calls the
Fibonacci contract and demonstrates successful calls, caught errors, and
wrapped errors.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli)
and read [Fibonacci](../fibonacci/README.md). From the repo root:

```sh
cargo test -p cross-call --locked
```

Expected: **8 tests pass**. The fixture registers both contracts, so no separate
deployment or running node is needed. Tests check return values and events from
both contracts.

## Read

1. [Contract](src/lib.rs): calls through `FibonacciClient`.
2. [Tests](tests/test.rs): caller/callee setup and error behavior.

## Try a change

Add another valid Fibonacci input to the success test. Compare a direct
`compute` call with `try_compute` when the input exceeds 30.

Next: [Error-handling callee](../error-handling-callee/README.md) and
[caller](../error-handling-caller/README.md).
