# Stellar account factory: deploy accounts from a master key

Deploys [Stellar accounts](../README.md) at an address computed
from the master key, and initializes each one in the same call frame, so no
account is ever visible uninitialized. The predicted address must already hold
the required native funding, like Stellar's starting balance.

## Run

Complete the [setup](../../../README.md#setup). From the repository root:

```sh
cargo test -p stellar-account-factory --locked
```

Expected: **7 tests pass**.

## Read

1. [Factory](src/lib.rs).
2. [Tests](tests/factory.rs): creation at the predicted address, unfunded
   predictions, and duplicate keys.

Next: [Stellar account](../README.md).
