# Groundhog Swap

Groundhog Swap is a local-development frontend for the example Uniswap V2-style swap contracts. It supports exact-input swaps against one configured token pair. It is not production software.

The browser uses a generated disposable private key. Treat the key as public development data, use it only on a disposable loopback ledger, and never fund it on a public network.

## Supported Stack

- Node.js 20.19 or newer
- Groundhog CLI 0.6.1
- Groundhog SDK 0.17.9
- Groundhog RPC and testkit 0.6.1
- `@groundhogchain/client` 0.1.6
- A compatible local node exposing RPC at `http://127.0.0.1:9545`

The Rust builds require access to the configured Groundhog crate registry.

## Install

From the repository root:

```sh
npm --prefix apps/swap ci
```

## Start A Clean Node

The validated stack uses the Groundhog RPC repository at commit `a096869`, including Groundhog CLI 0.6.1. Build and start `hog-devnode` using that repository's instructions; this examples repository does not manage node installation or ledger data. Record the path to the running node's runtime manifest. Setup requires:

- RPC available at `http://127.0.0.1:9545`, unless overridden.
- A runtime manifest from the running node.
- A fresh ledger whose chain tip is height 1.

Setup intentionally refuses a dirty ledger. Stop and reset the node before repeating setup.

## Configure The Environment

Export the validated CLI and runtime-manifest paths, then run setup:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545

npm --prefix apps/swap run setup:local
```

Setup builds the contracts, deploys two tokens and one swap suite, seeds liquidity, performs two smoke swaps, verifies events and views, and writes:

- `apps/swap/.env.local`: browser configuration and the disposable key.
- `apps/swap/.groundhog-config/`: generated CLI profile used by the crank.

Both paths are ignored by Git. Setup replaces `.env.local` only after every verification passes.

## Run The App

```sh
npm --prefix apps/swap run dev
```

Use one browser origin consistently. Do not alternate between `localhost` and `127.0.0.1`; browser locks and local storage are origin-scoped.

The primary flow is:

```text
Approve & swap
-> Approving swap, when needed
-> Submitting swap
-> Queued for execution
-> Execution observed
```

A successful router transaction only queues a request. It does not execute the swap.

## Process The Queue

After the app shows **Queued for execution**, run:

```sh
cd apps/swap
GROUNDHOG_CLI=/absolute/path/to/groundhog bash scripts/crank-local.sh
```

The script reads the generated driver address and entrypoint, validates the CLI profile and network, and invokes `process_requests()`. The app then observes either the request's `SwapEvent` or `RequestFailed` event.

Do not use **I cranked and confirmed the queue is drained** merely because the command was started. Use it only after independently confirming that the configured driver's queue was processed and no terminal event can be queried.

## Tests

Node-free frontend checks:

```sh
npm --prefix apps/swap run typecheck
npm --prefix apps/swap test
npm --prefix apps/swap run build
npm --prefix apps/swap audit --audit-level=low
```

Rust checks relevant to the swap application:

`swap-setup` runs without native node artifacts. Contract suites using the SDK's native execution environment also require authenticated Groundhog FFI artifacts. Provide either `HOGD_FFI_PASSWORD` for the artifact service or `HOGD_FFI_LIB_DIR` pointing to a compatible local `libtest_ffi` build.

```sh
cargo test -p swap-setup
cargo test -p swap-pair
cargo test -p swap-handler
cargo test -p swap-driver
cargo test -p swap-router
cargo test -p swap-factory
```

Shell syntax checks:

```sh
bash -n apps/swap/scripts/setup-local.sh
bash -n apps/swap/scripts/crank-local.sh
bash -n apps/swap/scripts/generate-contract-bindings.sh
```

The live integration test mutates a prepared local ledger by approving, enqueueing, cranking, and executing one swap. Run it only for final acceptance:

```sh
GROUNDHOG_CLI=/absolute/path/to/groundhog \
  npm --prefix apps/swap run test:integration:local
```

## Troubleshooting

### Setup requires a fresh ledger

Stop the node, remove its disposable ledger data using the node project's reset procedure, restart it, and verify the chain tip is height 1.

### Connection refused on port 9545

The node is not running or `GROUNDHOG_RPC_URL` points to the wrong endpoint. Setup does not start the node.

### Groundhog CLI 0.6.1 is required

Set `GROUNDHOG_CLI` to the validated 0.6.1 executable. The executable found first on `PATH` may be older.

### Setup completed deployment but `.env.local` is stale

Setup writes configuration only after all verification succeeds. Fix the final setup error, restart from a fresh ledger, and rerun setup. Restart Vite afterward so it reloads `.env.local`.

### Contract view faulted after restarting the node

The browser is probably using addresses generated for a previous ledger. Rerun setup against the fresh node, then restart Vite.

### Crank reports stale configuration

The generated CLI profile and `.env.local` belong to another runtime manifest or ledger. Rerun setup rather than editing generated addresses manually.

### Outcome uncertain after restarting Vite

The app preserves signed transactions in local storage when their receipt was not observed. Leave the request intact while the app checks its original hash. Do not submit another transaction unless the original is authoritatively invalid.

### Queued, but execution was not observed

Confirm that `crank-local.sh` completed against the current generated driver. Event absence is not proof of failure. After two visible minutes the app remains safely locked until execution is observed or you explicitly confirm that the relevant queue is drained.
