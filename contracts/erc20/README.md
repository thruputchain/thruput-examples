# ERC20: a larger token reference

This contract combines balances, allowances, token supply, events, and optional
metadata and signed permits. Start with [Counter](../counter/README.md) and
[Events](../events/README.md) if the SDK is new to you.

## Run native tests

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repository root:

```sh
cargo test -p erc20 --locked
```

Expect the native token lifecycle and same-block tests to pass. The RV32 test
is ignored in this command. No running node is needed.

## Read

1. [Public interfaces and features](src/lib.rs).
2. [Implementation](src/implementation.rs): balances, allowances, and events.
3. [Same-block tests](tests/same_block.rs): commuting updates and visibility.
4. [Native test](tests/test_native.rs) and [shared test cases](tests/common/contract_test.rs).

## Try a change

Add a transfer to the lifecycle test and assert both resulting balances. Keep
the underflow and allowance checks intact. For a client-side native HOG
transfer, see [the TypeScript examples](../../examples/typescript/README.md).

After CLI/runtime setup, `thruput test -p erc20` exercises the guest binary and
`thruput test --integration -p erc20 -- --test-threads=1` exercises RPC calls.
See [Development checks](../../scripts/README.md#checks) for the distinction.

Next: [Token Launchpad](../../apps/token-launchpad/README.md) for a full app,
or [permit-wallet](../permit-wallet/src/lib.rs) for signed authorization.
