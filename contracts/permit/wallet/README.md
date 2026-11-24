# Permit wallet: approve a token spend with an off-chain signature

Learn how an owner authorizes an ERC20 allowance with a signature made off
chain, like ERC-2612 `permit`. This wallet checks the signature and mints a
grant auth token. The [permit relayer](../relayer/README.md) carries that
token to the ERC20 contract in the same call frame.

Read [ERC20](../../erc20/README.md) first.

## Run

Complete the [setup](../../../README.md#setup). From the repository root:

```sh
cargo test -p permit-wallet --locked
```

Expected: **13 tests pass and 1 is ignored**. The ignored test runs the whole
flow on a local node:

```sh
bash contracts/permit/live.sh
```

## Read

1. [Wallet](src/lib.rs): signature checks, replay protection, and the grant it mints.
2. [Native tests](tests/permit.rs): permits, revokes, replays, and bad signatures.
3. [Live test](tests/testkit_permit.rs): sign off chain, relay, then spend.

Signature checks, replay protection, and the signed-message format come from
the `thruput-signed-op` crate.

## Try a change

Read `a_replayed_permit_is_refused` in the native tests. Then write a test
that signs a request with a different key from the wallet's owner key, and
check that the wallet refuses it with `SignedOpError::InvalidSignature`.

Next: [Permit relayer](../relayer/README.md).
