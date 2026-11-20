# Airdrop

A small contract example for one-time token claims. Each successful call transfers
all configured rewards to the calling wallet and marks that wallet as claimed.

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

## Verification

```sh
cargo test -p airdrop --locked --test test
cargo clippy -p airdrop --all-targets --no-deps --locked -- -D warnings
```

The [Airdrop app](../../apps/airdrop/README.md) exercises the compiled RV32
contract on a local node and provides a wallet-connected UI.
