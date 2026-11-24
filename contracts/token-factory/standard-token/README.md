# Standard token: the token that Launchpad creates

A metadata-enabled ERC20 that the [standard token factory](../factory/README.md)
deploys. Balances, allowances, metadata, holder burns, and administrator
clawback work as in the [ERC20 example](../../erc20/README.md). Two things
differ:

- **The factory initializes it.** `StandardTokenInitializer::initialize_from_factory`
  sets the name, symbol, decimals, administrator, and initial supply in one
  call, when the factory creates the token.
- **It has no signed permits.** It does not implement `ERC20Permit`; use the
  ERC20 example for that.

The [Launchpad app](../../../apps/token-launchpad/README.md) creates these tokens.

## Run

Complete the [setup](../../../README.md#setup). From the repository root:

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

Next: [Standard token factory](../factory/README.md).
