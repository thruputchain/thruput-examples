# Permit relayer: deliver a signed permit to a token

The [permit wallet](../wallet/README.md) mints a grant auth token from an
owner's signature. A token minted in one call frame must be used in the same
frame, so a contract has to make both calls back to back. This contract does
that. Anyone can call `relay`, as anyone can submit an ERC-2612 `permit`. It has
no storage.

## Run

The relayer has no tests of its own. The permit wallet's tests use it. From the
repository root:

```sh
cargo test -p permit-wallet --locked
bash contracts/permit/live.sh
```

## Read

- [Relayer](src/lib.rs): reads the signed request, calls the wallet, then calls
  the ERC20 with the grant.

Next: [Stellar account](../../stellar-account/README.md) for accounts with several
signers.
