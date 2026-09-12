# Thruput Token Launchpad

Create standard tokens through an external wallet and browse factory launches.
The directory uses the token registry; balances and creation verification use
live chain reads. The app never receives wallet private keys.

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

Keep that process running. Use the runtime-manifest path printed by the node in
the setup terminal:

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

Setup uses the manifest's storage costs and deploys an empty token factory. It
writes `.env.local` and the matching public contract artifact. Set
`GROUNDHOG_RPC_URL` if the node uses another loopback HTTP endpoint. The extension
uses localnet at `http://127.0.0.1:9545`.

Load the wallet extension, create or import a test wallet, select Localnet, and
request test HOG. Connect to Launchpad to create a token. Setup and seeding use
tooling accounts; they do not import keys into the browser.

## Seeding

With Launchpad's dev server running, create two indexed example tokens:

```sh
# Optional: set this before the first seed to assign your wallet as administrator.
export SEED_RECIPIENT=0x<your-wallet-public-address>
npm run seed --workspace apps/token-launchpad
```

The command creates **gUSD** and **gEUR**, each with six decimals and 1,000,000
units, through the real token factory. It waits for the registry to index their
creation events. Swap setup is not required for this step.

Without `SEED_RECIPIENT`, a generated tool account administers and owns the tokens.
With it, your wallet becomes administrator, but the tool account initially holds
the supply so it can provide liquidity. To receive spendable tokens and LP tokens,
finish [Swap seeding](../swap/README.md#seeding). That step supplies 1,000 of each
token to the pool and transfers the remaining 999,000 of each to your wallet.
The recipient is saved on the first run and cannot change on a rerun.

### State and recovery

State lives in ignored `.local/seed/<scope-digest>/` at the repository root:
`manifest.json` records addresses and signed transaction evidence; `signer.key`
is the tool account's plaintext private seed, created with mode `0600`; `lock/`
prevents concurrent runs. Keep the signer and manifest together and outside app
configuration. New state is scoped by network, token factory, and token code.
Existing journals from the earlier combined token/pool seeder are reused. Multiple
matching journals require manual resolution instead of creating another run.

Rerun the same command to resume. Completed transactions are read back; an
unexpired unknown transaction can be resubmitted with identical bytes. Expired
unknown transactions stop the run for investigation. After an authoritative
failure, fix its cause and set `SEED_RETRY_FAILED=1` to allow a replacement while
retaining the original evidence. A timeout alone does not permit replacement.

After a hard termination, remove only an empty `lock/` after confirming no seed
process is running. Preserve the journal. Rerunning setup deploys new infrastructure;
deleting seed state can create additional tokens on the same ledger.

| Override | Default |
| --- | --- |
| `SEED_STATE_DIR` | Repository `.local/seed` |
| `LAUNCHPAD_APP_ENV` | `apps/token-launchpad/.env.local` |
| `LAUNCHPAD_APP_PUBLIC_DIR` | `apps/token-launchpad/public` |
| `LAUNCHPAD_REGISTRY_URL` | `http://127.0.0.1:5173` |
| `GROUNDHOG_RPC_URL` | RPC URL from Launchpad setup |

RPC and registry endpoints must use loopback HTTP and reject redirects. Seeding
validates the live network and registry scope before submitting transactions.

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
- `scripts/`: application provisioning, seed entrypoint, and code generation.
- `../../scripts/seed/`: shared seeding and transaction recovery.

## Configuration and production

Setup publishes `.env.local` and immutable `public/contract-artifacts/<hash>.json`.
`VITE_STANDARD_TOKEN_HASH` identifies the implementation attached to token
creation. Builds and startup validate its hash. Rebuild after changing public
configuration; build and server manifests must agree.

Set `VITE_SWAP_APP_URL=http://127.0.0.1:5174` to offer Create AMM Pool after a
verified launch. Only the actual token address is passed; Swap still requires
connection and review. Optional explorer links use `VITE_EXPLORER_URL`.
Both links must use a root HTTPS origin or a supported loopback HTTP origin.
Restart development servers after changing `.env.local`. See [`.env.example`](.env.example)
for the full settings list.

Production needs `PORT` and `TOKEN_REGISTRY_DB_PATH` on a persistent volume.
The Railway configuration runs from the repository root and selects this npm
workspace explicitly; set its config-file path to `apps/token-launchpad/railway.json`.
Deploy the full npm workspace with GitHub Packages read authentication available
at install time. The SDK is installed from the registry. App RPC proxies stay
read-only; the extension submits to its own network endpoint. `/healthz` checks
database readiness and `/api/registry/status` reports indexing progress.
Use one writer per database, WAL-aware backups, and a new database for another
network/factory scope. Do not edit the stored scope. Build and start with:

```sh
npm run build --workspace apps/token-launchpad
npm run start --workspace apps/token-launchpad
```

Funding and creation are separate transactions. Recovery observes saved hashes,
and checking funding does not automatically request a new creation signature.
Keep uncertain transaction evidence until resolved on the original ledger.

## Tests

```sh
npm run typecheck --workspace apps/token-launchpad
npm run test --workspace apps/token-launchpad
```

Root `npm test` also runs shared seed and process-cleanup regressions.
`npm run test:browser` checks fixture-based browser interactions. Live
`npm run test:wallet` and `npm run test:seed` use a fresh node. Their prerequisites,
platform requirements, and coverage are in [Application checks](../../README.md#application-checks).
