# Thruput Token Launchpad

Create standard tokens through an external wallet and browse factory launches.
The directory uses the token registry; balances and creation verification use
live chain reads. The app never receives wallet private keys.

## Run locally

Install the built sibling `groundhog-client-ts` and run `npm ci` at the repository
root. Both example apps share that install and lockfile. Start a compatible local
node, then run from the repository root:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/token-launchpad
npm run dev --workspace apps/token-launchpad
```

Launchpad opens at `http://127.0.0.1:5173`. Its dev server runs the registry API
and indexer, using a factory-scoped SQLite file under `apps/token-launchpad/.local/`.
No extra registry process or registry-mode flag is needed. `TOKEN_REGISTRY_DB_PATH`
can override the file. Use only one writer per database.

Setup requires the running node's complete storage-cost manifest and deploys an
empty factory. Create/import a wallet, request test HOG, and connect to launch a
token. For the optional seeded demo, follow [Demo seeding](../../docs/demo-seeding.md).

## Commands

Run with `npm run <command> --workspace apps/token-launchpad`:

| Command | Purpose |
| --- | --- |
| `dev` | UI, read-only RPC proxy, registry API and indexer with Vite |
| `build` | Typecheck and production build |
| `start` | Serve the production build and registry; loads `.env.local` if present |
| `setup:local` | Build contracts and provision an empty token factory |
| `seed` | Create and index the two demo tokens |
| `generate:contracts` | Regenerate pinned contract bindings |
| `typecheck` | Browser and server TypeScript checks |
| `test` | Functional unit and integration tests |

Repository commands `npm run test:wallet` and `npm run test:seed` exercise isolated
full journeys. They require compatible CLI/devnode binaries and contract artifacts.

## Code map

- `src/app.tsx` and `src/routes.tsx`: configuration, providers and routes.
- `src/wallet/`: connection state and wallet controls.
- `src/launch/`: form validation, launch controller, review UI, execution and recovery.
- `src/tokens/`: registry directory controller and token cards.
- `src/transactions/`: prepare/sign/persist/submit and receipt observation.
- `src/contracts/generated/`: generated ABI bindings; do not edit by hand.
- `src/registry/`: registry API client and live-chain enrichment.
- `src/components/`: shared app UI and checked-in Radix primitives.
- `server/`: API, chain indexer, SQLite store and production startup.
- `scripts/`: application provisioning and code generation.
- `../../scripts/demo/`: coordinated seeding shared by both apps.

## Configuration and production

Setup publishes `.env.local` and immutable `public/contract-artifacts/<hash>.json`.
`VITE_STANDARD_TOKEN_HASH` identifies the implementation attached to token
creation. Builds and startup validate its hash. Rebuild after changing public
configuration; build and server manifests must agree.

Set `VITE_SWAP_APP_URL=http://127.0.0.1:5174` to offer Create AMM Pool after a
verified launch. Only the actual token address is passed; Swap still requires
connection and review. Optional explorer links use `VITE_EXPLORER_URL`.

Production needs `PORT` and `TOKEN_REGISTRY_DB_PATH` on a persistent volume.
Deploy the full npm workspace plus the built sibling SDK. App RPC proxies stay
read-only; the extension submits to its own network endpoint. `/healthz` checks
database readiness and `/api/registry/status` reports indexing progress.

Funding and creation are separate transactions. Recovery observes saved hashes,
and checking funding does not automatically request a new creation signature.
Keep uncertain transaction evidence until resolved on the original ledger.
