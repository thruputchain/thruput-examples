# Multi-impl: several interfaces at one address

Learn to define contract traits separately and implement more than one on a
single contract. `MathContract` implements addition and multiplication interfaces.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, with no node:

```sh
cargo test -p multi-impl --locked
```

Expected: **6 tests pass**, covering arithmetic, overflow, and both interfaces
at the same address.

## Read

1. [Interface crate](../../interfaces/multi-impl-if/src/lib.rs): trait definitions.
2. [Implementation](src/lib.rs): one contract implements the traits.
3. [Tests](tests/test.rs): use each generated client at the same address.

## Try a change

Add an arithmetic assertion through each client in the same test. Confirm that
both use the same deployed address and keep the overflow tests passing.

Next: [Mixed-impl](../mixed-impl/README.md).
