# Standard Token Factory TypeScript Tests

This harness validates the standard token factory through the published TypeScript client. It generates bindings from the contract XDR specs and runs against a fresh, ephemeral local node.

## Pinned Tools

- Node.js 22.12 or newer
- `@groundhogchain/client` 0.2.0
- Groundhog protocol packages 0.7.1
- `groundhog` CLI and binding generator 0.9.6
- `groundhog` local-node supervisor 0.9.1
- `hog-devnode` 0.1.19 at commit `046159036753c9c92ed0b13d66c6ad1e6ea6ccf7`
- Runtime protocol `hogp/0cd3c454cdeb`

Put `groundhog` 0.9.6 on `PATH` or set `GROUNDHOG` to its binary. Set `GROUNDHOG_NODE` to the published 0.9.1 binary; this matches the bootstrap-manifest and public RPC versions used by the pinned devnode. Set `GROUNDHOG_DEVNODE_BINARY` when the devnode is not installed at `~/.local/share/groundhog/hog-devnode/hog-devnode`.

```bash
npm ci
GROUNDHOG_NODE=/path/to/groundhog-0.9.1 npm test
```

`npm test` performs these steps:

1. Builds the standard token and factory RV32 artifacts with the locked Rust dependencies.
2. Generates TypeScript bindings from the token, factory, and test-wallet `.spec.xdr` files. The checked-in DevWallet binding was generated from the canonical client spec (`4e3d10d51600ad3b7f686766dd9a87795b32010b0b7665d69f33ef7d8ddd6fec`).
3. Type-checks the generated bindings and test harness.
4. Replays the Rust deterministic-address vectors.
5. Starts a clean node and runs the creation, token lifecycle, event, fee, and atomic storage top-up tests.

The atomic top-up test uses the pinned runtime's native default-wallet ABI. It proves the contract-level capability and rollback behavior only. Product wallets still need to detect an empty token reserve and offer the top-up flow to users.
