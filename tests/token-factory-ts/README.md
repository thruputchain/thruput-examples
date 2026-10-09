# Standard Token Factory TypeScript Tests

This harness validates the standard token factory through the published TypeScript client. It generates bindings from the contract XDR specs and runs against a fresh, ephemeral local node.

## Pinned Tools

- Node.js 22.13 or newer
- `@groundhogchain/client` 0.17.0
- Groundhog protocol packages 0.13.0
- `groundhog` CLI 0.26.0 or newer (binding generator and local-node supervisor)
- the `hog-devnode` that CLI manages (`0.1.30-rc.6`)

Put `groundhog` on `PATH` or set `GROUNDHOG` to its binary. Set `GROUNDHOG_NODE` only when the node supervisor is a different binary. The devnode is the one `groundhog toolchain which` reports; set `GROUNDHOG_DEVNODE_BINARY` to use another.

```bash
npm ci
npm test
```

`npm test` performs these steps:

1. Builds the standard token, factory, and test-wallet RV32 artifacts with the locked Rust dependencies.
2. Generates TypeScript bindings from their `.spec.xdr` files.
3. Type-checks the generated bindings and test harness.
4. Replays the Rust deterministic-address vectors.
5. Starts a clean node and runs the creation, token lifecycle, event, fee, and atomic storage top-up tests.

## Accounts

The harness generates two keys and starts the node with `--bootstrap-accounts`, so the node funds those keys' native accounts (the protocol's default wallet at each key's nonce-zero address) at genesis, and no others. Every transaction is signed by one of these keys through its default wallet.

Each factory is funded, deployed and initialized in one atomic transaction, so nobody can initialize it between deployment and configuration. The token's code is attached to the first token creation rather than deployed separately.

The atomic top-up test proves the contract-level capability and rollback behavior only. Product wallets still need to detect an empty token reserve and offer the top-up flow to users.

The funding and reserve figures in the lifecycle test are exact for the storage cost model the harness checks in the runtime manifest; they move with that model and with the token artifact's size.
