# Groundhog Token Launchpad

Local-development application for creating standard tokens through the Groundhog standard-token factory.

## Supported stack

- Node.js 22.13 or newer
- npm
- Groundhog CLI 0.10.4 or newer
- `hog-devnode` 0.1.25 or newer
- A disposable local node with at least three `local_user` accounts

## Install

The `@groundhogchain` packages come from GitHub Packages. On a machine without existing package access, create a GitHub token with `read:packages`, then configure npm without committing the token:

```bash
export GITHUB_PACKAGES_TOKEN=your_token
npm config set --location=user @groundhogchain:registry https://npm.pkg.github.com
npm config set --location=user //npm.pkg.github.com/:_authToken "$GITHUB_PACKAGES_TOKEN"
npm --prefix apps/token-launchpad ci
```

Run the remaining commands from the repository root.

## Local setup

Start a disposable local Groundhog node whose runtime manifest includes the faucet and at least three local-user accounts. Then point the setup command at its runtime manifest:

```bash
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_CLI="$(command -v groundhog)"
npm --prefix apps/token-launchpad run setup:local
npm --prefix apps/token-launchpad run dev
```

`setup:local` builds and registers the standard-token artifact, deploys and initializes a zero-fee factory, verifies its immutable configuration, and writes `.env.local`. The generated file contains disposable local private keys, has mode `0600`, and is excluded from Git. The development server refuses to expose these credentials from a non-loopback host. Production builds and previews omit them.

The factory deployment and initialization use separate transactions because the pinned development wallet cannot batch a root deployment with a child call. This is safe only on a disposable isolated node. Production tooling must deploy and initialize the factory atomically.

The checked `.env.example` documents the public configuration fields but is not a usable configuration. Setup also writes `GROUNDHOG_DEV_PERSONAS`, which contains the three disposable private keys.

## Clean-ledger acceptance

The acceptance command starts an ephemeral node, provisions the launchpad, creates and verifies one token each for Alice and Bob, checks creator-filtered and global discovery, then restores any existing `.env.local`:

```bash
export GROUNDHOG_DEVNODE_BINARY=/absolute/path/to/hog-devnode
npm --prefix apps/token-launchpad run test:e2e:local
```

The command requires Linux with Bash, `flock`, and `setsid`, Groundhog CLI 0.10.4 or newer, and `hog-devnode` 0.1.25 or newer. It must be run explicitly. The harness owns a disposable ledger, temporarily replaces and restores `.env.local`, and uses the repository's ignored build output.

This is a service-level acceptance journey: it exercises the same workflow, wallet boundary, RPC client, and discovery code as the app without driving a browser. Component tests cover configuration injection, routing, persona switching, recovery, and UI states.

## AMM Handoff

Set `VITE_SWAP_APP_URL` to the Swap root origin, for example
`http://127.0.0.1:5174`. Both apps must use the same RPC network hash. The
**Create AMM Pool** link appears only after committed creation and complete
verification, and sends only the actual token address as `tokenA`.
It does not wait for indexing, transfer a wallet, or submit an AMM transaction.
Blank configuration hides the link. Use HTTPS outside exact loopback hosts;
paths, credentials, queries, and fragments are rejected.

The full writable journey requires loopback Vite with disposable accounts.
Pointing the link at a production Swap deployment still redirects to its
read-only directory. Swap discovery needs this app's built production registry
service, not its writable Vite server. See the
[operator recipe](../../docs/cross-app-operations.md).

The shared-ledger acceptance command lives in Swap: `npm --prefix apps/swap run
test:e2e:cross-app` from the repository root, with the CLI/devnode/protocol
variables documented in the recipe. It uses both apps' actual SDK versions,
clicks the verified browser CTA, creates and seeds a pool, checks chain evidence,
and runs both production servers and full suites. No permanent browser dependency
is added to launchpad. See the
[acceptance record](../../docs/specs/2026-09-06-cross-app-acceptance.md).

## Local registry

Build the SPA, set the server variables shown in `.env.example`, and start the combined registry and web server:

```bash
npm --prefix apps/token-launchpad run build:production
npm --prefix apps/token-launchpad run start
```

`TOKEN_REGISTRY_DB_PATH` may point to a local ignored SQLite file. The configured RPC must expose the network and factory named by the same `VITE_*` values. The server rejects a database created for another network, factory, or standard-token hash.

## Railway production

Create one Railway service with `apps/token-launchpad` as its root directory. Railway's Config-as-code file path does not follow the root directory: set it explicitly to `/apps/token-launchpad/railway.json`, or configure the equivalent build, start, and health-check fields in the dashboard. Run exactly one replica: SQLite supports this deployment as one process and one writer, not horizontal scaling.

Attach one persistent volume at `/data` and set:

```text
TOKEN_REGISTRY_DB_PATH=/data/token-registry.sqlite
```

Set all of these variables for both the Railway build and runtime environments. Their values must be identical in both scopes:

```text
PORT=<provided by Railway>
VITE_GROUNDHOG_RPC_URL=<credential-free http or https RPC URL without a query or fragment>
VITE_GROUNDHOG_NETWORK_ID=<32-byte network hash>
VITE_GROUNDHOG_WALLET_ADDRESS=<32-byte public account address>
VITE_GROUNDHOG_WALLET_ENTRYPOINT=<wallet entrypoint>
VITE_NATIVE_HOG_ADDRESS=<32-byte native HOG address>
VITE_NATIVE_BALANCE_ITEM_COST=<pinned runtime item cost>
VITE_STANDARD_TOKEN_FACTORY_ADDRESS=<32-byte factory address>
VITE_STANDARD_TOKEN_HASH=<32-byte standard-token code hash>
VITE_TOKEN_REGISTRY_ENABLED=true
TOKEN_REGISTRY_DB_PATH=/data/token-registry.sqlite
```

Registry-enabled builds validate every listed `VITE_*` value and emit a public configuration manifest containing the public chain values plus only a one-way SHA-256 digest of the exact RPC URL. Server startup recomputes that digest and requires exact build/runtime equality for every setting before opening the registry database or listening; errors name the mismatched variable without logging its value. RPC URLs must use HTTP or HTTPS and must not contain credentials, a query string, or a fragment.

`TOKEN_REGISTRY_SYNC_INTERVAL_MS` defaults to `5000` and must be at least `1000`. `TOKEN_REGISTRY_PAGE_SIZE` defaults to `200` and must not exceed `500`.

Configure npm authentication in the build environment before dependency installation using the platform's secret-backed npm configuration and a GitHub token with `read:packages` access. Setting `GITHUB_PACKAGES_TOKEN` alone does not configure npm authentication. The project `.npmrc` contains only registry and install policies, so local installs use credentials from your user-level `~/.npmrc`. Use the commands declared in `railway.json`:

```text
Build: npm run build:production
Start: npm run start
Health: /healthz
```

`/healthz` checks that the process can query SQLite. It does not contact the chain, prove RPC availability, or replace monitoring and backups. `/api/registry/status` reports indexing progress and bounded sync errors.

Railway allows 30 seconds for connection draining during shutdown so the process can stop indexing and close SQLite cleanly.

The registry-enabled production browser bundle receives a benign placeholder instead of the upstream RPC URL and uses same-origin `/groundhog-rpc`. The production proxy permits only chain identity, tip, event, receipt, status, and view reads. It rejects `sendRawTransaction`; this deployment does not support production wallet writes or disposable development personas.

SQLite runs in WAL mode. Backups must capture a consistent database state, including outstanding WAL data; use a volume snapshot while the service is stopped or perform an SQLite-aware backup/checkpoint procedure. Copying only the main `.sqlite` file while the process is writing can lose committed data.

If startup reports a scope mismatch, do not reuse or edit the database. Restore the matching build/runtime network, factory, and token hash, or attach a fresh database path for the new scope. A fresh database starts indexing at retained chain history, which may be incomplete if older events have expired.

These instructions configure packaging only. They do not deploy the service.
