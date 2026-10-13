# Cross-trait throws: errors across interface boundaries

Learn how a caller handles an error declared by another interface on the same
contract. The ledger and pause interfaces have different error types; a ledger
operation can encounter a pause error.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli),
then read [Multi-throws](../multi-throws/README.md) and
[Multi-impl](../multi-impl/README.md). From the repo root:

```sh
cargo test -p cross-trait-throws --locked
```

Expected: **6 tests pass**, including each interface's own error, a peer
interface error, and `match_exn!` dispatch. No node is needed.

## Read

1. [Interfaces and contract](src/lib.rs).
2. [Tests](tests/test.rs): paused withdrawals and error classification.

## Try a change

In the peer-error test, compare a withdrawal before and after pausing. Verify
which error type is decoded instead of treating all failures as equivalent.

Next: [ERC20](../erc20/README.md), a larger contract using published interfaces.
