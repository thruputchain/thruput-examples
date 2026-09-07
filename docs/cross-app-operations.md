# Launchpad To Swap Operations

## Writable Local Journey

Use one disposable node and the same runtime manifest for both apps. Provision
Swap, then launchpad, sequentially; both use Alice's wallet. Never fund these
development keys on a public network. Run both apps' `npm ci` first.

From the repository root, with the node already running:

```sh
export GROUNDHOG_CLI="$HOME/Work/groundhog-rpc/target/debug/groundhog"
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545
npm --prefix apps/swap run setup:local
npm --prefix apps/token-launchpad run setup:local
```

These setup commands replace their generated local configuration. Back it up
first if needed. Unlike these interactive setup commands, the acceptance harness
uses temporary output paths and leaves existing files and symlinks untouched.

Add these settings to the generated local environments, retaining the generated
network, wallets, contracts, and disposable personas:

| Environment | Settings |
| --- | --- |
| Launchpad `.env.local` | `VITE_TOKEN_REGISTRY_ENABLED=false`; `VITE_SWAP_APP_URL=http://127.0.0.1:5174` |
| Swap `.env.local` | `VITE_POOL_REGISTRY_ENABLED=false`; `VITE_TOKEN_DISCOVERY_ENABLED=true`; `TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://127.0.0.1:3001` |
| Swap `.env.local` | Copy `VITE_STANDARD_TOKEN_FACTORY_ADDRESS` and `VITE_STANDARD_TOKEN_HASH` from launchpad. Do not replace Swap's own factory/router. |

The registry source is **launchpad's real production service** (`server/main.ts`),
which needs a production build with `VITE_TOKEN_REGISTRY_ENABLED=true`.
Its Vite development server does not supply `/api/tokens`. Build and start that
separate read-only service from `apps/token-launchpad`:

```sh
VITE_TOKEN_REGISTRY_ENABLED=true GROUNDHOG_DEV_PERSONAS= GROUNDHOG_DEV_PRIVATE_KEY= \
  node --env-file=.env.local node_modules/vite/bin/vite.js build --mode production
VITE_TOKEN_REGISTRY_ENABLED=true GROUNDHOG_DEV_PERSONAS= GROUNDHOG_DEV_PRIVATE_KEY= \
  PORT=3001 TOKEN_REGISTRY_DB_PATH=/tmp/launchpad-cross-app.sqlite \
  node --env-file=.env.local --import tsx server/main.ts
```

The explicit process environment overrides the local file. The server does not
load `.env.local` itself, hence `--env-file`. Use a fresh database for each new
ledger. Do not point two servers at one SQLite file. The acceptance harness also
starts Swap's production pool registry with its own database; the writable Swap
UI can read the chain without it when `VITE_POOL_REGISTRY_ENABLED=false`.

Start each Vite app in another terminal from the repository root:

```sh
npm --prefix apps/token-launchpad run dev -- --host 127.0.0.1 --port 5173 --strictPort
npm --prefix apps/swap run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Launch from `http://127.0.0.1:5173/create`, wait for complete verification, then
click **Create AMM Pool**. Swap loads live metadata before indexing. Select or
enter a funded second token, enter both amounts, review, then create. Manual
queue mode requires an explicit **Process liquidity queue** action. A queued
request is not delivered liquidity; verify the resulting pool reserves and LP.

A shared two-token URL is `/pools/new?tokenA=<address>&tokenB=<address>` on
the Swap origin. Presets contain only addresses, preserve A/B order, and never
populate amounts or bypass review. Editing the form does not rewrite the URL.

## Independent Production Deployment

Keep both production registry flags `true`, with public configuration identical
at build and runtime. Do not supply `GROUNDHOG_DEV_PERSONAS` or
`GROUNDHOG_DEV_PRIVATE_KEY`. Follow each app's README for its database, RPC,
health checks, and deployment settings. Rebuild when any public integration
setting changes or when upgrading the public manifest schema.

Set Swap's server-only upstream to the HTTPS **root origin** of the launchpad
registry service. Never use a path, API key, browser-supplied URL, or broad CORS
rule. Keep the upstream out of `VITE_*` settings. Discovery uses only same-origin
`GET /api/token-discovery?q=...`; status and token pages are fetched server-side.
The launchpad CTA URL is public. Neither URL authenticates the remote network;
operators must align network/factory/hash configuration.

Production serves discovery but never mounts pool creation or relays transaction
RPC methods. A CTA targeting production navigates to the read-only directory;
it does not grant signing permission. Optional registry failure does not make
deployment health depend on upstream availability.

## Failure Handling

- Search matches name, symbol, token address, and creator address. Only the newest
  20 matches are offered; refine broad queries. Limited history is not a full index.
- No match or an upstream outage does not invalidate an address. Use manual entry
  and live metadata retry. Indexed metadata never replaces authoritative review.
- RPC network mismatch blocks live previews and new review. Correct the network,
  not the token. Registry scope mismatch rejects suggestions but leaves manual
  live reads independent.
- Recovery takes precedence over URL presets. Resume the original workflow;
  do not clear transaction evidence to force a different pair. Do not resubmit
  an uncertain transaction as a new one.
- A production manifest mismatch requires matching configuration and a rebuild,
  not editing the manifest. Scope changes require a separate matching database.

## Repeatable Acceptance

From `apps/swap`:

```sh
GROUNDHOG_CLI="$HOME/Work/groundhog-rpc/target/debug/groundhog" \
GROUNDHOG_DEVNODE_BINARY="$HOME/.local/share/groundhog/hog-devnode/hog-devnode" \
GROUNDHOG_E2E_HOGD_PROTOCOL=hogp/4166df9d6a5411d \
npm run test:e2e:cross-app
```

Requires Linux `flock`, Node >=22.13, both dependency trees, Chromium
(`/usr/bin/chromium` or `CHROMIUM_PATH`), and contract-build registry access.
The existing Swap `playwright-core` dependency is reused. One fresh node uses
dynamic ports, three disposable funded accounts, isolated XDG/CLI state, and
separate temporary databases. Provisioning is sequential. Indexing is delayed
until after the verified browser handoff, then restarted to catch up.

The harness asserts that both `.env.local` files (including symlink identity and
target contents) and generated Swap CLI config remain unchanged. It removes
owned process groups and temporary state on success, failure, SIGINT, and SIGTERM.
SIGKILL cannot run cleanup. Ignored build outputs remain; do not run setup or
build commands concurrently. Run `npm run test:browser:tokens` separately for
the existing 320px touch/focus and controlled-race browser coverage.

The final command runs both full test suites, typechecks, and production builds
after live acceptance. A failed gate exits nonzero and reports the boundary;
later gates are not silently counted as passed. See the dated
[acceptance record](specs/2026-09-06-cross-app-acceptance.md).
