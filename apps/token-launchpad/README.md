# Groundhog Token Launchpad

Application for creating standard tokens through the Groundhog standard-token factory using a browser wallet provider. Public token browsing does not require a wallet.

## Supported stack

- Node.js 22.13 or newer
- npm
- Groundhog CLI 0.14.0 or newer
- `hog-devnode` 0.1.25 or newer
- A disposable local node with the pinned storage-cost profile
- A Groundhog browser wallet supporting provider protocol 1.0.0
- A built sibling checkout of `groundhog-client-ts` (the app uses `file:../../../groundhog-client-ts`)

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

Start a disposable local Groundhog node with the pinned storage-cost profile. Bootstrap users and a bootstrap faucet are not required. Then point the setup command at its runtime manifest:

```bash
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_CLI="$(command -v groundhog)"
npm --prefix apps/token-launchpad run setup:local
npm --prefix apps/token-launchpad run dev
```

`setup:local` deploys and initializes a zero-fee factory, verifies its immutable configuration, and writes public infrastructure settings to `.env.local`. It does not deploy a standard-token instance. Setup exports immutable `public/contract-artifacts/<hash>.json`, where `<hash>` is the lowercase, 0x-prefixed `VITE_STANDARD_TOKEN_HASH`, containing `{contractType: 'rv32', data: '0x...', hash: '0x...'}`. Vite copies this asset into production output.

The factory deployment and initialization use separate transactions because the pinned development wallet cannot batch a root deployment with a child call. This is safe only on a disposable isolated node. Production tooling must deploy and initialize the factory atomically.

The checked `.env.example` documents the public configuration fields but is not a usable configuration. Wallet addresses, wallet entrypoints, and private keys are not browser configuration. Connect a discovered wallet and authorize its account on the configured network. Account or network changes invalidate the old signing adapter and remount the account-scoped workflow.

Only factory `create_token` writes fetch the standard-token artifact, from `/contract-artifacts/<hash>.json` on the same origin with a timeout and an 8 MiB response limit. The app verifies both the declared hash and `hashContract` against `VITE_STANDARD_TOKEN_HASH` before signing, then attaches the contract to `prepareExecution`. Missing or mismatched artifacts block signing. Funding and public browsing never fetch this asset.

Every production build validates the required public artifact's exact schema and computed hash before bundling. Server startup repeats the same read-only validation against the served `dist` artifact before contacting RPC or opening the database. Neither validation runs setup, deploys a contract, or writes an artifact. A missing artifact is a build/startup error, including registry-enabled deployments.

The SDK wraps each inner call through DefaultWallet. The app awaits signed-hash persistence before asking the extension to submit the approved bytes. Persistence failures never broadcast. Submission errors preserve uncertainty and poll the canonical signed hash; recovery observes existing transactions without signing again. Successful receipts decode the single DefaultWallet child return for factory verification while preserving receipt hashes and events.

## Clean-ledger acceptance

Run `npm run test:e2e:wallet` from either app to build the extension and run the real cross-app harness, `scripts/test-wallet-extension.mjs` at the repository root. Live acceptance must verify the very first token deployment without pre-registered token code, the actual created address, TokenCreated and mint-event semantics, wallet changes, and creator-filtered discovery. Unit tests exercise the real SDK provider signing boundary and generated bindings; they do not establish live chain acceptance.

## AMM Handoff

Set `VITE_SWAP_APP_URL` to the Swap root origin, for example
`http://127.0.0.1:5174`. Both apps must use the same RPC network hash. The
**Create AMM Pool** link appears only after committed creation and complete
verification, and sends only the actual token address as `tokenA`.
It does not wait for indexing, transfer a wallet, or submit an AMM transaction.
Blank configuration hides the link. Use HTTPS outside exact loopback hosts;
paths, credentials, queries, and fragments are rejected.

Wallet access is authorized separately for each app origin. Swap discovery needs
this app's built production registry service, not its Vite server. See the
[operator recipe](../../docs/cross-app-operations.md).

The [earlier acceptance record](../../docs/specs/2026-09-06-cross-app-acceptance.md)
predates provider wallets and is not acceptance evidence for GH-251.

## Explorer Links

Set optional `VITE_EXPLORER_URL` to the explorer's root origin on the same
network, such as `https://explorer.example.com` or `http://localhost:3001`.
Absent or blank configuration disables links, but identifiers remain shortened
with their full values available in tooltips on hover or keyboard focus.
Remote origins require HTTPS. HTTP is allowed only for exact `localhost`,
`127.0.0.1`, or `[::1]` hosts. Credentials, paths, queries, fragments, and
malformed URLs are rejected; a root slash is normalized away.

Addresses (wallets and contracts) open `/address/0x<64 hex digits>` and
transactions open `/tx/0x<64 hex digits>` in a new tab. Nonces and implementation
hashes remain unlinked. Copy buttons copy the original full value independently
of navigation. The same-tab **Create AMM Pool** handoff is independent of this
setting.

Rebuild production assets after changing this value and supply the same origin
at runtime. The exact public manifest includes `VITE_EXPLORER_URL` even when
disabled (as an empty string); missing keys and build/runtime drift are rejected.

## Local registry

Build the SPA, set the server variables shown in `.env.example`, and start the combined registry and web server:

```bash
npm --prefix apps/token-launchpad run build:production
npm --prefix apps/token-launchpad run start
```

`TOKEN_REGISTRY_DB_PATH` may point to a local ignored SQLite file. The configured RPC must expose the network and factory named by the same `VITE_*` values. The server rejects a database created for another network, factory, or standard-token hash.

## Railway production

Create one Railway service with `apps/token-launchpad` as its root directory. Railway's Config-as-code file path does not follow the root directory: set it explicitly to `/apps/token-launchpad/railway.json`, or configure the equivalent build, start, and health-check fields in the dashboard. Run exactly one replica: SQLite supports this deployment as one process and one writer, not horizontal scaling.

The current local SDK dependency requires the built sibling `groundhog-client-ts` checkout in the build context at the same relative path. A launchpad-only deployment context will not install it. Include the generated standard-token public artifact before building; rebuilding does not run setup or generate it.

Attach one persistent volume at `/data` and set:

```text
TOKEN_REGISTRY_DB_PATH=/data/token-registry.sqlite
```

Set all of these variables for both the Railway build and runtime environments. Their values must be identical in both scopes:

```text
PORT=<provided by Railway>
VITE_GROUNDHOG_RPC_URL=<credential-free http or https RPC URL without a query or fragment>
VITE_GROUNDHOG_NETWORK_ID=<32-byte network hash>
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

The registry-enabled production browser bundle receives a benign placeholder instead of the upstream RPC URL and uses same-origin `/groundhog-rpc`. Both local and production proxies permit only chain identity, tip, event, receipt, status, and view reads. They reject `sendRawTransaction`; the extension owns submission. Registry mode does not disable connected-wallet writes. The manifest strictly checks infrastructure drift but contains no wallet identity or entrypoint.

SQLite runs in WAL mode. Backups must capture a consistent database state, including outstanding WAL data; use a volume snapshot while the service is stopped or perform an SQLite-aware backup/checkpoint procedure. Copying only the main `.sqlite` file while the process is writing can lose committed data.

If startup reports a scope mismatch, do not reuse or edit the database. Restore the matching build/runtime network, factory, and token hash, or attach a fresh database path for the new scope. A fresh database starts indexing at retained chain history, which may be incomplete if older events have expired.

These instructions configure packaging only. They do not deploy the service.
