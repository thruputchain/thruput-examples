# Fibonacci: a stateless contract

Learn to expose a method with `#[contract]`, throw a declared error, and emit an
event. The contract stores no state. It computes Fibonacci numbers recursively
and rejects inputs above 30 to bound the work.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, with no node:

```sh
cargo test -p fibonacci --locked
```

Expected: **4 tests pass**, covering values, the input limit, one event, and
multiple events. The value for input 10 is 55.

## Read

1. [Contract](src/lib.rs): `compute`, `FibError`, and `FibComputed`.
2. [Tests](tests/test.rs): deploy in the native test environment and call `FibonacciClient`.

The recursive calculation is deliberately simple; this is an SDK example, not
an optimized Fibonacci algorithm.

## Try a change

Add an assertion that input 6 returns 8. Then add a call with input 31 and check
the declared `InputTooLarge` error using the existing error test as a guide.

Next: [Events](../events/README.md), then [Cross-call](../cross-call/README.md).
