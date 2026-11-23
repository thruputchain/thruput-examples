# Standard token factory: create tokens at predictable addresses

Learn to deploy and initialize a contract from another contract. Each token
lands at an address that the creator can compute before creating it.
The [Launchpad app](../../../apps/token-launchpad/README.md) uses this factory.

The factory writes no shared state when it creates a token, so many tokens can
be created in the same block. To list the tokens, an app reads the factory's
`TokenCreated` events. The Launchpad indexer does this.

## Run

Complete the [setup](../../../README.md#setup). From the repository root:

```sh
cargo test -p standard-token-factory --locked
```

Expected: **11 tests pass and 1 is ignored**. The ignored test is a simulation
on a local node.

## Read

1. [Factory](src/implementation.rs): `predict_token`, the funding check, and
   `create_token`.
2. [Factory tests](tests/factory.rs): creation, fees, and errors.
3. [Concurrency tests](tests/concurrency.rs): two creations in one block.

## Try a change

In the factory tests, predict a token address, create the token, and check
that it landed at the predicted address.

Next: the [Launchpad app](../../../apps/token-launchpad/README.md).
