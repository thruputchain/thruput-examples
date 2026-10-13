# Mixed-impl: inherent methods and a trait

Learn to expose an inherent `#[contract]` implementation and an explicit trait
implementation on one stateful contract. The vault's ordinary methods and
reset interface share storage but have distinct interface/error declarations.

## Run

Complete the [Rust setup](../../docs/getting-started.md#1-rust-and-registry-access)
and read [Multi-impl](../multi-impl/README.md). From the repo root:

```sh
cargo test -p mixed-impl --locked
```

Expected: **5 tests pass**, covering both interfaces and their errors. No node
is needed.

## Read

1. [Vault and Resettable](src/lib.rs).
2. [Tests](tests/test.rs): calls through both generated client surfaces.

## Try a change

Change a stored value in the combined-interface test and verify that the reset
operation changes the value observed through the vault client.

Next: [Cross-trait throws](../cross-trait-throws/README.md).
