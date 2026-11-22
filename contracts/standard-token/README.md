# Standard token: the token that Launchpad creates

A metadata-enabled ERC20 that the [standard token factory](../standard-token-factory/README.md)
deploys. It keeps the behavior of the [ERC20 example](../erc20/README.md), and
adds holder burns and administrator clawback. The
[Launchpad app](../../apps/token-launchpad/README.md) creates these tokens.

## Run

Complete the [setup](../../README.md#setup). From the repository root:

```sh
cargo test -p standard-token --locked
```

Expected: **15 tests pass**. They check balances, allowances, metadata, events,
and initialization by the factory.

## Read

1. [Contract](src/implementation.rs).
2. [Conformance tests](tests/conformance.rs).

## Try a change

In the lifecycle test, change the burn amount and update the expected balance and total supply.

Next: [Standard token factory](../standard-token-factory/README.md).
