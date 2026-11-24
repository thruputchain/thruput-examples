# Airdrop

A small contract example for one-time token claims. Each successful call transfers
all configured rewards to the calling wallet and marks that wallet as claimed.
Start with [Counter](../counter/README.md) and [ERC20](../erc20/README.md).

## Run

Complete the [setup](../../README.md#setup). From the repository root:

```sh
cargo test -p airdrop --locked --test test
```

Expected: **7 tests pass**.

## Read

1. [Contract](src/implementation.rs).
2. [Tests](tests/test.rs): claims, eligibility, and duplicate claims.

## Configuration

`initialize(rewards, addresses)` accepts 1–16 unique token addresses with positive
raw-unit amounts, plus up to 256 eligible addresses. An empty address list means
any wallet can claim. A nonempty list restricts claims to those addresses.
Rewards and eligibility are fixed after initialization.

Deploy and initialize in one atomic transaction. The app setup script uses the
SDK's deployment initializer; never leave a deployed contract uninitialized.
Fund it with the configured tokens and enough native tokens for claim storage.
Token contracts also need native storage funding for new recipient balance rows.

## Claim behavior

- The recipient is `get_caller()`, not a caller-supplied destination.
- Each address can claim once per contract deployment.
- An exclusive per-address claim marker prevents concurrent duplicate claims.
- If any transfer fails, all transfers and the claim marker roll back.
- Successful claims emit `Claimed` with the recipient address.

An open airdrop cannot distinguish one developer from many addresses controlled
by that developer. Its funded token budget limits total distributions. This is
a teaching example, not proof of unique human identity. The optional allowlist
demonstrates eligibility without adding signatures or Merkle proofs.

## Try a change

In `empty_allowlist_allows_each_wallet_once`, add a third wallet. Check that it
can claim once, and that its second claim fails.

Next: the [Airdrop app](../../apps/airdrop/README.md), which runs this contract
on a local node with a wallet.
