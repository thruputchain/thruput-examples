# Token factory

A factory contract that creates ERC20 tokens at addresses the creator can
compute in advance. The [Launchpad app](../../apps/token-launchpad/README.md)
creates its tokens with it.

The factory writes no shared state when it creates a token, so many tokens can
be created in the same block.

## Read in this order

| Folder | Crate | What it does |
| --- | --- | --- |
| [`interface/`](interface/src/lib.rs) | `standard-token-factory-if` | The token and factory interfaces, and the address derivation. The token and the factory depend on this crate, not on each other. |
| [`standard-token/`](standard-token/README.md) | `standard-token` | The token that the factory deploys: an ERC20 with metadata, holder burns, and administrator clawback. |
| [`factory/`](factory/README.md) | `standard-token-factory` | Predicts a token's address, then deploys and initializes the token in one call. |
| [`failing-child/`](failing-child/src/lib.rs) | `token-factory-failing-child` | A test-only token that writes state and then fails, to show that a failed creation leaves nothing behind. |

## Run

Complete the [setup](../../README.md#setup). From the repository root:

```sh
cargo test -p standard-token -p standard-token-factory -p standard-token-factory-if --locked
```

Each crate's README has the expected result and an exercise.
