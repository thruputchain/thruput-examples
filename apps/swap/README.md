# Thruput Swap

Create pools, swap tokens, and manage liquidity through an external wallet.
The directory uses the pool registry; balances, reserves, and transaction
verification use live chain reads. The app never receives wallet private keys.

## Requirements

- Node.js 22.13 or newer and the [shared SDK/npm install](../../README.md#install-swap-and-launchpad-dependencies).
- A compatible Groundhog CLI/devnode pair and the node's full runtime manifest.
- [Thruput Wallet](../wallet-extension/README.md) for browser transactions.

## Local setup

Run from the repository root. Start a disposable node in a separate terminal:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
"$GROUNDHOG_CLI" node --port 9545 --dev-account-count 0 --json
```

Keep that process running, or reuse the node already started for Launchpad. Use
its printed runtime-manifest path in the setup terminal:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/swap
npm run dev --workspace apps/swap
```

Swap opens at `http://127.0.0.1:5174`. Its dev server runs the registry API and
indexer, using a factory-scoped SQLite file under `apps/swap/.local/`. No extra
registry process or registry-mode flag is needed. `POOL_REGISTRY_DB_PATH` can
override the file. Use only one writer per database.

Setup deploys infrastructure only. Connect Thruput Wallet, request test HOG,
create tokens in Launchpad, and create a pool. Setup writes `.env.local` and the
matching public contract artifact. Set `GROUNDHOG_RPC_URL` for another loopback
HTTP endpoint; the extension uses localnet at `http://127.0.0.1:9545`.

## Seeding

First [set up and seed Launchpad](../token-launchpad/README.md#seeding) on the
same node. Keep its dev server running: Swap seeding resolves those exact token
addresses through Launchpad's registry API. After Swap setup, run:

```sh
npm run seed --workspace apps/swap
```

The command creates one **gUSD/gEUR** pool, supplies **1,000 of each token**,
processes the queued liquidity request, and verifies its mint event, reserves,
and LP balance. The pool appears through Swap's normal registry indexer.

Set `SEED_RECIPIENT` to your extension's public address **before the first
Launchpad seed** to receive LP tokens and the remaining **999,000 of each token**.
Otherwise, the tool account owns them. No wallet key or approval is needed by
the seeder; request test HOG separately in the extension for browser transactions.

Both phases share `.local/seed/<scope-digest>/` at the repository root. The first
pool run binds the journal to its Swap factory, router, and LP code. A different
Swap setup is rejected on rerun. Before writing, the tool also verifies that the
live factory and router reference each other.

Rerun to resume the existing request. A successful crank is not proof of a mint:
the seeder checks the correlated terminal event and submits at most four new
cranks per invocation. A recorded request failure stops further processing.
Keep the original signer and transaction journal when a result is uncertain.
See [seed state and recovery](../token-launchpad/README.md#state-and-recovery)
for lock recovery, explicit failed-transaction retries, and shared path overrides.

Additional pool overrides are `SWAP_APP_ENV` (default `apps/swap/.env.local`) and
`SWAP_APP_PUBLIC_DIR` (default `apps/swap/public`). `LAUNCHPAD_REGISTRY_URL` defaults
to `http://127.0.0.1:5173`. Both app configurations must name the same network.

## Commands

Run with `npm run <command> --workspace apps/swap`:

| Command | Purpose |
| --- | --- |
| `dev` | UI, read-only RPC proxy, registry API and indexer with Vite |
| `build` | Typecheck and production build |
| `start` | Serve the production build and registry; loads `.env.local` if present |
| `setup:local` | Build contracts and provision empty application infrastructure |
| `seed` | Create the demo pool from the seeded Launchpad tokens |
| `generate:contracts` | Regenerate pinned contract bindings |
| `typecheck` | Browser and server TypeScript checks |
| `test` | Functional unit and integration tests |

## Code map

- `src/app.tsx` and `src/routes.tsx`: configuration, providers and routes.
- `src/wallet/`: connection state and wallet controls.
- `src/pools/`, `src/swap/`: feature pages, calculations and workflows.
- `src/transactions/`: prepare/sign/persist/submit, receipt observation and recovery.
- `src/contracts/generated/`: generated ABI bindings; do not edit by hand.
- `src/registry/`: registry API client and live-chain enrichment.
- `src/components/`: shared app UI and checked-in Radix primitives.
- `server/`: API, chain indexer, SQLite store and production startup.
- `scripts/`: application provisioning, seed entrypoint, and code generation.
- `../../scripts/seed/`: shared seeding and transaction recovery.

The [Swap contract overview](../../contracts/swap-router/README.md) explains the
request queue, permissions, pool funding, and contract relationships.

The bindings use the current batch-driver event signatures and structured
`RequestFailed` payload. After updating from an older contract suite, run setup
on a fresh disposable node. Preserve unresolved transaction records from the
old deployment; the new bindings are not a decoder for its older event format.

## Configuration and production

Setup publishes `.env.local` and immutable `public/contract-artifacts/<hash>.json`.
`VITE_POOL_TOKEN_HASH` identifies the LP token implementation attached to pool
creation. Builds and startup validate its hash. Rebuild after changing public
configuration; build and server manifests must agree.

See [`.env.example`](.env.example) for RPC, factory/router, explorer and discovery
settings. To search Launchpad's indexed tokens, add these after setup, copying
the factory address and token code hash from Launchpad's `.env.local`:

```dotenv
VITE_TOKEN_DISCOVERY_ENABLED=true
TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://127.0.0.1:5173
VITE_STANDARD_TOKEN_FACTORY_ADDRESS=0x...
VITE_STANDARD_TOKEN_HASH=0x...
```

The server checks the registry's network/factory identity. Manual token addresses
remain valid when discovery is disabled or unavailable. Restart dev servers after
changing environment files. Launchpad can link to `/pools/new?tokenA=<address>`;
`tokenB` is also supported. These links prefill addresses only: existing recovery
takes priority, and connection, live validation, and review are still required.

Production needs `PORT` and `POOL_REGISTRY_DB_PATH` on a persistent volume.
The Railway configuration runs from the repository root and selects this npm
workspace explicitly; set its config-file path to `apps/swap/railway.json`.
Deploy the full npm workspace with GitHub Packages read authentication available
at install time. The SDK is installed from the registry. App RPC proxies stay
read-only; the extension submits to its own network endpoint. `/healthz` checks
database readiness and `/api/registry/status` reports indexing progress.
Use one writer per database, WAL-aware backups, and a new database for another
network/factory scope. Do not edit the stored scope. Build and start with:

```sh
npm run build --workspace apps/swap
npm run start --workspace apps/swap
```

Enqueueing is not execution. Approve queue processing and observe the correlated
terminal event. Keep uncertain transaction hashes; a timeout is not permission
to send a replacement. Account changes invalidate old write bindings.

## Tests

```sh
npm run typecheck --workspace apps/swap
npm run test --workspace apps/swap
```

Root `npm test` also runs shared seed and process-cleanup regressions.
`npm run test:browser` checks fixture-based browser interactions. Live
`npm run test:wallet` and `npm run test:seed` use a fresh node. Their prerequisites,
platform requirements, and coverage are in [Application checks](../../README.md#application-checks).
