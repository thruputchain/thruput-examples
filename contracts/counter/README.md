# Counter: your first stateful contract

Learn to store a non-negative integer, call generated client methods, and test
an error. `NNInt` supports commutative updates; this example adds and subtracts
amounts instead of replacing a stored value.

## Run

Complete the [Rust setup](../../docs/getting-started.md#1-rust-and-registry-access).
From the repo root, without a node or npm:

```sh
cargo test -p counter --locked --test test
```

Expected: **2 tests pass**. The first initializes to 10, increments by 5,
decrements by 3, and reads 12. The second catches a decrement below zero.
The expected exception can appear in the test output; the final result is what
determines success.

## Read

1. [Implementation](src/implementation.rs): `NNInt`, generated methods, and `PingEvent`.
2. [Native tests](tests/test.rs): register, deploy, invoke, and assert results.
3. [Manifest](Cargo.toml): `dev` enables native testing; `entrypoints` enables the guest binary.

`initialize` adds to the counter; it is not a one-time initialization guard.
`error` is an explicit error demonstration, not an authorization policy.

## Try a change

In `test_counter`, increment by 7 instead of 5. Change the expected values to 17
and 14, then rerun the test. The below-zero test should still pass.

Next: [Fibonacci](../fibonacci/README.md) for a stateless contract, or
[TypeScript deployment](../../examples/typescript/README.md) to call this contract
on a node. The [Counter app](../../apps/counter/README.md) is a larger concurrency
demo, not required for this example.
