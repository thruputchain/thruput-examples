# Groundhog Swap TypeScript Setup

Status: Final

Date: 2026-08-21

## Objective

Replace the Rust/Testkit setup program with a small application-local TypeScript provisioner. Setup deploys and initializes the swap environment, seeds liquidity, and writes configuration for the browser and crank script.

Contract behavior belongs in contract and live integration tests. Setup does not perform verification swaps or duplicate client validation.

The AMM frontend and [Local Wallet Personas](./2026-08-22-local-wallet-personas.md) specifications supersede this document's singular application account and fixed provisioning details. The current setup uses Alice, Bob, and Carol, distributes three example tokens, and gives Alice the seeded pool's initial LP position while preserving the transaction and generated-file boundaries defined here.

## Toolchain

Use these exact package versions:

- `@groundhogchain/client` 0.3.0
- `@groundhogchain/contract-spec` 0.7.1
- `@groundhogchain/protocol` 0.7.1
- `@groundhogchain/xdr` 0.7.1
- `tsx` 4.22.4
- `smol-toml` 1.8.0

Also require Node.js 22.12 or newer, Groundhog CLI 0.9.6 or newer, and a node serving stable RPC wire format `>=3.0.0`.

## Boundaries

The client owns:

- Runtime-manifest discovery and validation
- Bootstrap-account selection and signer derivation
- Transaction receipt polling
- Contract invocation, receipt, view, and event codecs

The swap setup owns:

- Reading the manifest's network hash and derivation seed for browser configuration
- Deriving the disposable browser private key
- Loading built contract artifacts
- The thin DevWallet transaction path
- Swap-specific provisioning
- Generated browser and CLI configuration

Setup does not enforce a loopback RPC URL or a fresh ledger. It is not idempotent; callers remain responsible for the lifecycle of their disposable development node.

Do not add a generic wallet client, deployment framework, service container, manifest validator, receipt observer, event codec, or RV32 parser.

## DevWallet Binding

Check in the canonical DevWallet spec and generated binding:

```text
apps/swap/specs/dev_wallet.spec.xdr
apps/swap/src/contracts/generated/dev-wallet.ts
```

The spec SHA-256 is:

```text
4e3d10d51600ad3b7f686766dd9a87795b32010b0b7665d69f33ef7d8ddd6fec
```

Binding generation verifies this checksum and generates DevWallet and SwapFactory alongside the existing contract bindings.

Use the generated `DevWallet.deploy` and `DevWallet.doAction` descriptors. `doAction` declares a `void` return, but the runtime forwards nested target return bytes into the root receipt. Validate the root execution result and verify target effects through views instead of applying the void receipt decoder.

## Shell Entry Point

`apps/swap/scripts/setup-local.sh` remains the command behind `npm --prefix apps/swap run setup:local`.

It must:

1. Require `GROUNDHOG_CLI` and `GROUNDHOG_RUNTIME_MANIFEST`.
2. Default `GROUNDHOG_RPC_URL` to `http://127.0.0.1:9545`.
3. Require Groundhog CLI 0.9.6 or newer.
4. Delete stale generated configuration before building.
5. Build ERC-20, SwapFactory, SwapRouter, SwapHandler, SwapDriver, and SwapPair.
6. Export the artifact and output paths.
7. Run the local `tsx` binary.

The TypeScript program does not spawn the Groundhog CLI or discover its configuration.

## Inputs

The TypeScript setup reads:

- `GROUNDHOG_RUNTIME_MANIFEST`
- `GROUNDHOG_RPC_URL`
- `SWAP_ARTIFACT_ROOT`
- `SWAP_APP_ENV`
- `SWAP_CLI_CONFIG_HOME`

It parses only `networkHash` and `bootstrapAccountDerivation.seed` from the manifest. `loadLocalDevAccount` remains authoritative for manifest and account validation:

```ts
const faucet = await loadLocalDevAccount({ role: "faucet" });
const applicationUser = await loadLocalDevAccount();
```

The browser private key is:

```text
SHA-256("<bootstrap seed>:account-<application-user index>")
```

Setup loads the six fixed `.rv32a` artifacts from `SWAP_ARTIFACT_ROOT` and requires stable RPC wire format `>=3.0.0`.

## Transaction Boundary

Keep the complete example in `scripts/setup-local.ts`. Build each DevWallet deployment or action invocation at its call site so the signing account, target, and attached binaries remain visible. Share only the private `submit` function that constructs, authorizes, signs, submits, and waits for a transaction.

Every transaction uses a random 64-bit replay nonce, expires 1,000 blocks after the current tip, uses source-address authorization for public key ID 0, signs once, submits once, and waits with `waitForTransactionReceipt`.

Use one gas limit of `10_000_000` for DevWallet and nested invocations. Require `ExecResultOK`. Decode deployed addresses that the workflow uses with the generated DevWallet descriptor.

## Provisioning Workflow

Run these operations in order:

1. Register SwapPair, SwapHandler, and SwapDriver binaries.
2. Deploy token A with the ERC-20 binary and token B from its registered hash.
3. Fund both tokens with native HOG.
4. Initialize `Groundhog USD` / `gUSD` and `Groundhog EUR` / `gEUR` with six decimals.
5. Mint `2_000_000_000` units of each token to the application user.
6. Deploy, fund, and initialize SwapFactory.
7. Deploy, fund, and initialize SwapRouter.
8. Read the pool addresses and fund the liquidity token, pair, handler, and driver.
9. Approve exactly `1_000_000_000` units of each token for the handler.
10. Enqueue and process the initial liquidity request.
11. Require both initial reserves to equal `1_000_000_000`.

The setup does not perform swaps. The live integration test owns swap, event, allowance, balance, and reserve verification.

## Generated Configuration

After provisioning succeeds, write:

- `apps/swap/.groundhog-config/groundhog/config.toml`
- `apps/swap/.env.local`

Write the CLI configuration first and `.env.local` last, both with mode `0600`. The shell script deletes stale outputs before setup starts.

The environment contains only values consumed by the browser or crank script: RPC URL, network hash, application private key, wallet address and entrypoint, router, pair, handler, driver, token addresses, symbols, decimals, and the driver's `processRequests` entrypoint.

## Verification

Run:

```sh
npm --prefix apps/swap run typecheck
npm --prefix apps/swap test
npm --prefix apps/swap run build
bash -n apps/swap/scripts/setup-local.sh
bash -n apps/swap/scripts/crank-local.sh
bash -n apps/swap/scripts/generate-contract-bindings.sh
cargo test --workspace --locked --no-run
cargo fmt --check
git diff --check
```

For live acceptance, run setup against a disposable node, run `test:integration:local`, test the generated shell crank, and complete one browser swap with the in-app crank.
