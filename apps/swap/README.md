# Groundhog Swap

Groundhog Swap is a local-development frontend for the example Uniswap V2-style swap contracts. It supports exact-input swaps against one configured token pair. It is not production software.

The local development server injects a generated disposable private key while serving the app; production builds do not contain it. Treat the key as public development data, use it only on a disposable loopback ledger, and never fund it on a public network.

## Supported Stack

- Node.js 22.12 or newer
- npm
- Groundhog CLI 0.9.6 or newer
- Groundhog SDK 0.19.0
- Groundhog RPC and testkit 0.9.0
- `@groundhogchain/client` 0.2.0
- A compatible local node exposing RPC at `http://127.0.0.1:9545`

The Rust builds require access to the configured Groundhog crate registry.

## Install

From the repository root:

The `@groundhogchain` packages come from GitHub Packages. On a machine without existing package access, create a GitHub token with `read:packages`, then configure npm without committing the token:

```sh
export GITHUB_PACKAGES_TOKEN=your_token
npm config set --location=user @groundhogchain:registry https://npm.pkg.github.com
npm config set --location=user //npm.pkg.github.com/:_authToken "$GITHUB_PACKAGES_TOKEN"
```

```sh
npm --prefix apps/swap ci
```

Transitive dependency deprecation warnings are non-blocking when installation succeeds.

## Start A Clean Node

The workspace uses Groundhog RPC and testkit 0.9.0 with Groundhog SDK 0.19.0, and requires Groundhog CLI 0.9.6 or newer. Build and start `hog-devnode` using the Groundhog RPC repository's instructions; this examples repository does not manage node installation or ledger data. Record the path to the running node's runtime manifest. Setup requires:

- RPC available at `http://127.0.0.1:9545`, unless overridden.
- A runtime manifest from the running node.
- A fresh ledger whose chain tip is height 1.

Setup intentionally refuses a dirty ledger and a runtime manifest that does not identify a fresh `hogd-dev` runtime. Stop and reset the node before repeating setup.

## Configure The Environment

Export the validated CLI and runtime-manifest paths, then run setup:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545

npm --prefix apps/swap run setup:local
```

Setup validates a loopback-only RPC URL, derives the disposable key from the fresh runtime manifest, builds the contracts, deploys two tokens and one swap suite, seeds liquidity, performs two smoke swaps, verifies events and views, and writes:

- `apps/swap/.env.local`: browser configuration and the disposable key.
- `apps/swap/.groundhog-config/`: generated CLI profile used by the crank.

Both paths are ignored by Git. Setup invalidates old generated files before touching the ledger, then publishes both replacements with restrictive permissions only after every verification passes. If setup fails after deployment starts, reset the disposable ledger before retrying.

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
-> Submit another swap or crank the driver queue
-> Executed or Failed, independently for each request
```

A successful router transaction only queues a request. It does not execute the swap. The form remains available after enqueueing, so one account can submit up to 10 pending swaps before a crank. The app permits only one approval or submission workflow at a time and serializes those workflows across tabs.

Each quote uses the latest observed reserves. The app does not project earlier queued swaps into later quotes, promise queue order, or treat expected queued output as spendable. The handler recalculates output against live reserves during execution and fails a request when slippage protection cannot satisfy its submitted minimum output.

The app reserves each unresolved input amount against that token's displayed balance. Before submission, it ensures the handler allowance covers the new input plus all unresolved exposure for the same token. Opposite swap directions maintain separate reservations and allowance targets.

The request list stores unresolved requests and up to 50 recent terminal results in origin-scoped local storage. Each row shows its submitted input, minimum output, lifecycle status, and actual output when execution is recorded. Terminal history can be dismissed without affecting unresolved requests.

## Process The Queue

After the app shows **Queued for execution**, use **Crank queue** in the request
list. This signs and submits `process_requests()` through the same loopback-only
browser wallet boundary used for swaps.

Queue processing is driver-wide. It can process requests that are not present in
the browser's local history, and one transaction may not drain a large or changing
queue. The app reconciles matching receipt events and continues observing every
unresolved local request. A committed crank does not by itself prove that all
local requests reached a terminal state.

If the crank outcome is uncertain, the app preserves its original transaction
hash and blocks another crank. Use **Check crank status** rather than retrying.

The shell command remains available as a fallback:

```sh
cd apps/swap
GROUNDHOG_CLI=/absolute/path/to/groundhog bash scripts/crank-local.sh
```

The script reads the generated driver address and entrypoint, validates the CLI profile and network, and invokes `process_requests()`. The app correlates each `SwapEvent` or `RequestFailed` event by request ID and updates requests independently. Crank guidance remains visible while any request still needs processing.

If a queued request has no decodable request ID, automatic event correlation is unavailable. Use **Resolve manually** only after independently confirming that the relevant queue was drained, then complete the separate confirmation step. Tracked queued requests remain in the list until a matching terminal event arrives.

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

The live integration test mutates a prepared local ledger by enqueueing two swaps before one crank, correlating both terminal events, and checking aggregate balances, allowance, and reserves. Run it only for final acceptance:

```sh
npm --prefix apps/swap run test:integration:local
```

## Troubleshooting

### Setup requires a fresh ledger

Stop the node, remove its disposable ledger data using the node project's reset procedure, restart it, and verify the chain tip is height 1.

### Connection refused on port 9545

The node is not running or `GROUNDHOG_RPC_URL` points to the wrong endpoint. Setup does not start the node.

### Groundhog CLI packaging release 0.1.19 or newer is required

Set `GROUNDHOG_CLI` to a packaging release 0.1.19 or newer executable. The executable found first on `PATH` may be older.

### Setup completed deployment but `.env.local` is stale

Setup invalidates old configuration before deployment and publishes new configuration only after all verification succeeds. Reset to a fresh disposable ledger, fix the setup error, and rerun setup. Restart Vite afterward so it reloads `.env.local`.

### Contract view faulted after restarting the node

The browser is probably using addresses generated for a previous ledger. Rerun setup against the fresh node, then restart Vite.

### Crank reports stale configuration

The generated CLI profile and `.env.local` belong to another runtime manifest or ledger. Rerun setup rather than editing generated addresses manually.

### Outcome uncertain after restarting Vite

The app preserves each signed transaction in local storage when its receipt was not observed. Leave the request intact while the app checks its original hash. Do not retry an uncertain transaction unless the original is authoritatively invalid.

### Queued, but execution was not observed

Confirm that `crank-local.sh` completed against the current generated driver. Event absence is not proof of failure. After two visible minutes the request remains reserved and observation continues. Other swaps may still be submitted when their input token has enough unreserved balance. Only an untracked request can be resolved manually, and only after explicit queue-drained confirmation.
