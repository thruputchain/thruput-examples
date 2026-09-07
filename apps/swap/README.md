# Groundhog AMM

Groundhog AMM discovers and reads example Uniswap V2-style pools. Local development supports disposable write workflows; the packaged registry deployment is read-only.

The local development server injects three generated disposable wallet personas while serving the app; production builds do not contain them. Treat every key as public development data, use it only on a disposable development ledger, and never fund it on a public network.

## Supported Stack

- Node.js 22.13 or newer
- npm
- Groundhog CLI 0.14.0 or newer
- Groundhog SDK 0.30.0
- Groundhog RPC and testkit 0.14.0
- `@groundhogchain/client` 0.6.0
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

## Start A Node

The workspace pins Groundhog RPC and testkit 0.14.0 with Groundhog SDK 0.30.0, and the swap scripts enforce Groundhog CLI 0.14.0 or newer plus RPC wire format 3.0.0 or newer. Build and start `hog-devnode` using the Groundhog RPC repository's instructions; this examples repository does not manage node installation or ledger data. Record the path to the running node's runtime manifest. Setup requires:

- RPC available at `http://127.0.0.1:9545`, unless overridden.
- A runtime manifest from the running node.
- At least three `local_user` bootstrap accounts (`--dev-account-count 3`).

Setup does not enforce a fresh ledger and is not idempotent. Starting with a fresh disposable node remains the simplest option, especially after a partial setup failure.

## Configure The Environment

Export the validated CLI and runtime-manifest paths, then run setup:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545

npm --prefix apps/swap run setup:local
```

Setup derives Alice, Bob, and Carol from the runtime manifest, builds the contracts, deploys three tokens and one shared AMM, distributes tokens to all three wallets, seeds one gUSD/gEUR pool from Alice, checks Alice's initial LP position, and writes:

- `apps/swap/.env.local`: browser configuration and the disposable persona keys.
- `apps/swap/.groundhog-config/`: generated CLI profile used by the crank.

Both paths are ignored by Git. Setup invalidates old generated files before building and writes both replacements with mode `0600` after provisioning succeeds.

## Run The App

```sh
npm --prefix apps/swap run dev
```

Use one browser origin consistently. Do not alternate between `localhost` and `127.0.0.1`; browser locks and local storage are origin-scoped.

The development server must listen on a loopback host while disposable credentials are enabled. It disables cross-origin access and refuses non-loopback hosts. Do not use `vite --host 0.0.0.0` or expose this app to a local network.

Use the development-wallet control in either header to switch this tab among Alice, Bob, and Carol. Pools and queues are shared, while balances, allowances, LP positions, transaction history, and recovery state belong to the selected account. Alice begins as the initial liquidity provider; Bob and Carol begin with tokens but no LP position. Selection is tab-local, so separate tabs may use different personas.

The wallet portfolio includes all tokens provisioned by local setup, even before they belong to a pool. This makes the seeded gJPY balance available when creating and funding a new market.

Each pool consists of a liquidity-token contract, a handler, and a driver. The
handler is the canonical pool address: it owns pool state and emits successful
swap and liquidity events. The driver queues requests and emits request
failures. There is no separately deployed pair contract.

Pool creation reads the factory's per-contract funding policy, approves three
times the recommended amount of native HOG to the factory, and calls
`create_pair` once. The factory creates and funds all three pool contracts
atomically. Initial token allowances are then granted to the new handler before
liquidity is submitted through the router. If another account creates the same
pool first, the app requires the unused factory allowance to be removed before
the user can continue with initial liquidity.

Browser records from the previous four-contract protocol use retired storage
namespaces. The app intentionally ignores them rather than migrating, merging,
or deleting them; clear site data if those inert records are no longer useful.

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
list. This signs and submits `process_requests()` through the same development
wallet boundary used for swaps.

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

The script reads the generated driver address and entrypoint, uses the generated CLI profile, and invokes `process_requests()`. The app correlates each `SwapEvent` or `RequestFailed` event by request ID and updates requests independently. Crank guidance remains visible while any request still needs processing.

If a queued request has no decodable request ID, automatic event correlation is unavailable. Use **Resolve manually** only after independently confirming that the relevant queue was drained, then complete the separate confirmation step. Tracked queued requests remain in the list until a matching terminal event arrives.

## Registry Deployment

The production package runs the built SPA, pool registry API, read-only RPC proxy, indexer, and SQLite owner in one Node process. Packaging does not deploy the service.

Set every variable in `.env.example` in both the Railway build and runtime environments. The production build records normalized public configuration and only the SHA-256 digest of the upstream RPC URL; startup fails before opening SQLite or listening when any build/runtime value differs. `VITE_POOL_REGISTRY_ENABLED` must be `true`. The browser uses same-origin `/groundhog-rpc`, has no development wallet, hides write controls, and redirects pool creation, swap, and liquidity routes to read-only pages.

For a local combined-process check with real non-secret deployment values already exported:

```sh
cd apps/swap
npm run build:production
POOL_REGISTRY_DB_PATH=./pools.sqlite PORT=3000 npm start
```

Configure Railway with `apps/swap` as the root directory and `/apps/swap/railway.json` as the config path. The checked-in config requires one replica and a volume mounted at `/data`; SQLite must never be shared by replicas. If a legacy service does not apply config-as-code fields, set the same replica, volume, health-check, draining, and restart values in the service dashboard. Set `POOL_REGISTRY_DB_PATH=/data/pools.sqlite`. The health check is `GET /healthz`; registry progress and faults are available at `GET /api/registry/status`. During deploys Railway allows 30 seconds for health checks and draining.

When `RAILWAY_ENVIRONMENT_ID` is present, the server trusts Railway's [documented client remote-IP header](https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications), `X-Real-IP`, for per-client RPC limits. It accepts exactly one valid IPv4 or IPv6 address and never trusts `X-Forwarded-For`. Outside Railway it ignores forwarding headers and limits by the socket peer address.

The `@groundhogchain` packages require a GitHub token with `read:packages` during installation. Configure npm authentication in the build environment before dependency installation using the platform's secret-backed npm configuration. Setting `GITHUB_PACKAGES_TOKEN` alone does not configure npm authentication. The project `.npmrc` contains only registry and install policies, so local installs use credentials from your user-level `~/.npmrc`.

Backups must preserve WAL consistency. Use SQLite's backup mechanism, or stop the service before copying the database, `-wal`, and `-shm` files together. A network or factory scope mismatch is intentionally fatal: restore matching configuration/database state or start with a fresh database; do not edit registry scope metadata.

## Tests

Node-free frontend checks:

```sh
npm --prefix apps/swap run typecheck
npm --prefix apps/swap test
npm --prefix apps/swap run build
npm --prefix apps/swap audit --audit-level=low
```

Rust contract checks that use the SDK's native execution environment require authenticated Groundhog FFI artifacts. Provide either `HOGD_FFI_PASSWORD` for the artifact service or `HOGD_FFI_LIB_DIR` pointing to a compatible local `libtest_ffi` build.

```sh
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
bash -n apps/swap/scripts/test-clean-ledger.sh
```

The clean-ledger acceptance command starts an ephemeral node on a free loopback port, provisions the AMM, runs one ordered journey across Alice, Carol, and Bob, then stops the node. It restores any existing `.env.local` and generated CLI profile when it exits. Set the installed `hog-devnode` path before running it:

```sh
export GROUNDHOG_DEVNODE_BINARY=/absolute/path/to/hog-devnode
npm --prefix apps/swap run test:e2e:local
```

Use matching Groundhog CLI and `hog-devnode` releases. For a known wire-compatible local devnode build whose protocol token differs from the CLI, pass the token explicitly:

```sh
export GROUNDHOG_E2E_HOGD_PROTOCOL=hogp/your-token
npm --prefix apps/swap run test:e2e:local
```

The prepared-ledger integration tests remain available for focused live checks. They mutate shared state and may run concurrently, so do not use this command as the clean-ledger acceptance harness:

```sh
npm --prefix apps/swap run test:integration:local
```

## Troubleshooting

### Connection refused on port 9545

The node is not running or `GROUNDHOG_RPC_URL` points to the wrong endpoint. Setup does not start the node.

### Groundhog CLI 0.14.0 or newer is required

Set `GROUNDHOG_CLI` to a Groundhog CLI 0.14.0 or newer executable. The executable found first on `PATH` may be older.

### Setup completed deployment but `.env.local` is stale

Setup invalidates old configuration before building and writes new configuration after provisioning succeeds. Fix the setup error and rerun setup. If the failure left partial state that prevents retrying, restart with a clean disposable ledger. Restart Vite afterward so it reloads `.env.local`.

### Contract view faulted after restarting the node

The browser is probably using addresses generated for a previous ledger. Rerun setup against the current node, then restart Vite.

### Crank targets missing contracts

The generated CLI profile or `.env.local` may belong to another ledger. Rerun setup rather than editing generated addresses manually.

### Outcome uncertain after restarting Vite

The app preserves each signed transaction in local storage when its receipt was not observed. Leave the request intact while the app checks its original hash. Do not retry an uncertain transaction unless the original is authoritatively invalid.

### Queued, but execution was not observed

Confirm that `crank-local.sh` completed against the current generated driver. Event absence is not proof of failure. After two visible minutes the request remains reserved and observation continues. Other swaps may still be submitted when their input token has enough unreserved balance. Only an untracked request can be resolved manually, and only after explicit queue-drained confirmation.
