# Permit

An owner approves an ERC20 spend with a signature made off chain, like
ERC-2612 `permit`. Read [ERC20](../erc20/README.md) first.

## Read in this order

| Folder | Crate | What it does |
| --- | --- | --- |
| [`wallet/`](wallet/README.md) | `permit-wallet` | Checks the owner's signature and mints a grant auth token. |
| [`relayer/`](relayer/README.md) | `permit-relayer` | Delivers the grant to the ERC20 in the same call frame, which a grant needs. |

## Run

Complete the [setup](../../README.md#setup). From the repository root:

```sh
cargo test -p permit-wallet --locked
```

[`live.sh`](live.sh) builds the artifacts and runs the whole flow on a local
node: sign off chain, relay, then spend. It needs the devnode toolchain
(`thruput toolchain install`).

```sh
bash contracts/permit/live.sh
```
