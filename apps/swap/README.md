# Thruput Swap

Create pools, swap tokens, and manage liquidity through an external wallet.
The directory uses the pool registry; balances, reserves, and transaction
verification use live chain reads. The app never receives wallet private keys.

## Run locally

Install the built sibling `groundhog-client-ts` and run `npm ci` at the repository
root. Both example apps share that install and lockfile. Start a compatible local
node, then run from the repository root:

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
create tokens in Launchpad, and create a pool. For the optional seeded demo,
follow [Demo seeding](../../docs/demo-seeding.md).

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

Repository command `npm run test:browser` covers both apps' browser interactions.
`npm run test:wallet` and `npm run test:seed` exercise isolated
full journeys. They require compatible CLI/devnode binaries and contract artifacts.

## Code map

- `src/app.tsx` and `src/routes.tsx`: configuration, providers and routes.
- `src/wallet/`: connection state and wallet controls.
- `src/pools/`, `src/swap/`: feature pages, calculations and workflows.
- `src/transactions/`: prepare/sign/persist/submit, receipt observation and recovery.
- `src/contracts/generated/`: generated ABI bindings; do not edit by hand.
- `src/registry/`: registry API client and live-chain enrichment.
- `src/components/`: shared app UI and checked-in Radix primitives.
- `server/`: API, chain indexer, SQLite store and production startup.
- `scripts/`: application provisioning and code generation.
- `../../scripts/demo/`: coordinated seeding shared by both apps.

## Configuration and production

Setup publishes `.env.local` and immutable `public/contract-artifacts/<hash>.json`.
`VITE_POOL_TOKEN_HASH` identifies the LP token implementation attached to pool
creation. Builds and startup validate its hash. Rebuild after changing public
configuration; build and server manifests must agree.

See `.env.example` for RPC, factory/router, explorer and discovery settings.
Optional discovery uses `TOKEN_DISCOVERY_UPSTREAM_ORIGIN` pointing at Launchpad
(normally `http://127.0.0.1:5173` locally) and its factory/code hash. Manual token
addresses remain valid when discovery is disabled or unavailable.

Production needs `PORT` and `POOL_REGISTRY_DB_PATH` on a persistent volume.
Deploy the full npm workspace plus the built sibling SDK. App RPC proxies stay
read-only; the extension submits to its own network endpoint. `/healthz` checks
database readiness and `/api/registry/status` reports indexing progress.

Enqueueing is not execution. Approve queue processing and observe the correlated
terminal event. Keep uncertain transaction hashes; a timeout is not permission
to send a replacement. Account changes invalidate old write bindings.
