# Standard Token Factory TypeScript Tests

This harness validates the standard token factory through the published TypeScript client. It generates bindings from the contract XDR specs and runs against a fresh, ephemeral local node.

## Pinned Tools

- Node.js 22.12 or newer
- `@groundhogchain/client` 0.4.0
- Groundhog protocol packages 0.8.0
- `groundhog` CLI, binding generator, and local-node supervisor 0.10.4
- `hog-devnode` 0.1.25-rc.1

Put `groundhog` 0.10.4 on `PATH` or set `GROUNDHOG` to its binary. Set `GROUNDHOG_NODE` only when the node supervisor is a different binary. Set `GROUNDHOG_DEVNODE_BINARY` when the devnode is not installed at `~/.local/share/groundhog/hog-devnode/hog-devnode`.

```bash
npm ci
GROUNDHOG=/path/to/groundhog-0.10.4 npm test
```

`npm test` performs these steps:

1. Builds the standard token and factory RV32 artifacts with the locked Rust dependencies.
2. Generates TypeScript bindings from the token, factory, and test-wallet `.spec.xdr` files. The canonical DevWallet binding is provided by `@groundhogchain/client/contracts`.
3. Type-checks the generated bindings and test harness.
4. Replays the Rust deterministic-address vectors.
5. Starts a clean node and runs the creation, token lifecycle, event, fee, and atomic storage top-up tests.

## Deployment Limitation

This local test harness deploys and initializes a factory in separate transactions. During that gap, any account could initialize the factory first and permanently set its configuration. This is acceptable only on the harness's isolated, ephemeral node; release and production tooling must deploy and initialize the factory atomically in one call tree. The pinned DevWallet cannot batch calls, and DefaultWallet deployment is root-only, so an atomic flow requires a dedicated deployment helper or future wallet support.

The atomic top-up test uses the pinned runtime's native default-wallet ABI. It proves the contract-level capability and rollback behavior only. Product wallets still need to detect an empty token reserve and offer the top-up flow to users.
