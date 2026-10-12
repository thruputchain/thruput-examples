# Thruput Swap

Create pools, swap tokens, and manage liquidity through an external wallet.
The directory uses the pool registry; balances, reserves, and transaction
verification use live chain reads. The app never receives wallet private keys.

## Application structure

Swap and Token Launchpad follow the same application skeleton:

```text
src/main.tsx           Load runtime config and create the read client; retry startup
src/app.tsx            Compose providers → router → layout → routes
src/app-providers.tsx  Own stable Query, wallet, tooltip, and explorer providers
src/app-layout.tsx     Render the persistent banner, header, navigation, and wallet UI
src/routes.tsx         Select feature routes and apply wallet/workflow policy
```

Both apps keep app-wide UI in `src/components/`, wallet UI in `src/wallet/`,
client integration in `src/thruput/`, general helpers in `src/lib/`, browser
registry access in `src/registry/`, and transaction execution/recovery in
`src/transactions/`. `src/contracts/` contains bindings, `src/setup/` contains
setup support, and `src/test/` contains shared test helpers. Module tests live
beside their source. `server/`, `shared/`, `scripts/`, and `public/` have the same
roles in both examples: backend, browser/server models and constants, tooling,
and static assets.

Swap's feature directories are `src/pools/`, `src/swap/`, and
`src/token-discovery/`; Launchpad uses `src/tokens/` and `src/launch/`.
Swap also retains `src/domain/` for pure amount, allowance, reservation, and
token-ordering rules shared by pool creation, liquidity, swapping, and transaction
execution. Swap-only quotes and workflow state live in `src/swap/`.

Start with `app.tsx` and `app-layout.tsx`, then follow `routes.tsx` into
`pools/pool-route-view.tsx` and `swap/swap-route.tsx`. Pages own their content
and `<main>`, while the layout owns the global header. Signing-binding changes
reset write forms below the layout; public directory filters and the providers
remain mounted. Swap's additional `ProcessingModeProvider` preserves the chosen
processing mode across routes.

## Requirements

- Node.js 22.13 or newer and the [shared SDK/npm install](../../README.md#install-swap-and-launchpad-dependencies).
- A compatible Thruput CLI/devnode pair and the node's full runtime manifest.
- [Thruput Wallet](../wallet-extension/README.md) for browser transactions.

## Local setup

Run from the repository root. Start a disposable node in a separate terminal:

```sh
export THRUPUT_CLI=/absolute/path/to/thruput
"$THRUPUT_CLI" node --port 9545 --json
```

Keep that process running, or reuse the node already started for Launchpad. Use
its printed runtime-manifest path in the setup terminal:

```sh
export THRUPUT_CLI=/absolute/path/to/thruput
export THRUPUT_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/swap
npm run dev --workspace apps/swap
```

Swap opens at `http://127.0.0.1:5174`. Its dev server runs the registry API and
indexer, using a factory-scoped SQLite file under `apps/swap/.local/`. No extra
registry process or registry-mode flag is needed. `POOL_REGISTRY_DB_PATH` can
override the file. Use only one writer per database.

`setup:local` builds contracts, regenerates bindings, and runs the TypeScript
setup script. Path overrides are resolved from the repository root.

Setup deploys infrastructure only. Connect Thruput Wallet, request test HOG,
create tokens in Launchpad, and create a pool. Setup writes `.env.local` and the
matching public contract artifact. Set `THRUPUT_RPC_URL` for another loopback
HTTP endpoint; the extension uses localnet at `http://127.0.0.1:9545`.

## Devnet setup

```sh
export THRUPUT_CLI=/absolute/path/to/thruput
export THRUPUT_RPC_URL=https://rpc.thruput.network
export THRUPUT_NETWORK_ID=0xabb9cdbc56285d0e71c9845273ca06211fedf7ee2f58c43cfac6060f9402aa0f
npm run setup:devnet --workspace apps/swap
```

Each run builds the contracts and bindings, funds a fresh tool-only deployer,
deploys and initializes empty Swap infrastructure, and writes `.env.devnet` plus
the public LP-token code asset. The deployer key is never saved or published.
There is no setup journal. Failed setup leaves the previous environment intact.

The hosted RPC chooses the airdrop amount; this deployment received **1,000 HOG**.
Devnet requires HTTPS and an explicit network hash. A local runtime manifest is
not used. Verify the live hash after a Devnet reset before running setup again.

### Recorded Devnet deployment

Verified on **2026-09-15 UTC** against RPC **0.17.2**, wire format **5.2.0**:

| Field | Value |
| --- | --- |
| RPC | `https://rpc.thruput.network` |
| Network ID | `0xabb9cdbc56285d0e71c9845273ca06211fedf7ee2f58c43cfac6060f9402aa0f` |
| Factory | `0xd09b6848ad37e0afd7841f2d19f8315a28a27791015342d1fe381c7efe3f78a6` |
| Router | `0x4762d730a050aedb33a1bf56ccc90ec2873634ccf28343f1c7d3bf64c3ce0248` |
| Handler code-registration instance | `0x6c0004bf77bb314f44a6349b77566177dbb42afbf47482cac5eae441d0d38e2b` |
| Driver code-registration instance | `0xa5515d88fd8849e05dcf09181b52e7830ff5ac26240d90b353c1f62f5c4af135` |
| Driver code hash | `0x0ac0a63e84939d14eeb9b9b38838f22296322f69d94798add9460e36840783ce` |
| LP token code hash | `0x152d5e4635c5322cb1fbc75e7584cd6565d8e4802c04e9c4e9b75b4e7fb90776` |
| Factory deployment transaction | `0x9c8253c497364394b65b8f4c2eea22ccd8b1d241a628694f0400949e9486eeb2` |
| Router deployment transaction | `0xa6fc044c92ebe064a1b3c28552436b17258ea2d5ba88c9df07e710af061d159d` |

The factory was verified empty, with protocol fees disabled and a valid pool
funding policy. The registration instances make handler/driver code available;
each user-created pool gets its own initialized handler and driver.

This deployment uses the 2,000,000-gas handler request limits proposed in
[PR #95](https://github.com/groundhogchain/groundhog-examples/pull/95).

Use the saved `.env.devnet` to host this deployment. Running setup again creates
different addresses. To run the app locally against Devnet:

```sh
npm run dev --workspace apps/swap -- --mode devnet
```

The local development proxy permits read-only HTTPS RPC calls in this mode.
Connect a wallet configured for Devnet to submit transactions. Token discovery
starts disabled; configure the deployed Launchpad registry URL before enabling it.

`SWAP_APP_ENV`, `SWAP_ARTIFACT_ROOT`, and `SWAP_APP_PUBLIC_DIR` override the
environment output, compiled artifact directory, and public asset directory.
Relative paths resolve from the repository root.

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
| `setup:devnet` | Build and provision fresh infrastructure on a pinned Devnet network |
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

Bindings are generated by CLI 0.27.0 from contracts built with Rust SDK 0.49.0.
The AMM uses `LiquidityMintEvent` and `LiquidityBurnEvent`; supported scalar
topics are encoded directly, while string and byte-slice topics remain hashes.
Run setup to deploy matching rebuilt contracts. The historical Devnet addresses
above are not updated by a dependency bump; use their original bindings when
recovering old activity.

## Configuration and production

Setup publishes `.env.local` or `.env.devnet` and immutable `public/contract-artifacts/<hash>.json`.
`VITE_POOL_TOKEN_HASH` identifies the LP token implementation attached to pool
creation. Server startup validates the served artifact against this hash before
opening deployment state. The browser loads public settings from `/api/config`
and always calls `/thruput-rpc`; upstream URLs stay server-side. Configuration
changes require a server restart and page reload, not a frontend rebuild. Keep
the deployed artifacts and generated bindings paired when changing contract code.

The LP-token code asset for the recorded Devnet deployment is checked in so a
clean checkout can build and create pools. If a future setup produces
a different code hash, include its matching public asset with the deployment.

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
## React integration

`src/main.tsx` initializes runtime config and a stable, network-validated client
with retryable startup UI. `src/app-providers.tsx` composes the official wallet
and Query providers. The transaction hook composes `useWalletClient()` with app
policy; only write forms reset when that signing binding changes. Wallet discovery,
session invalidation, and client disposal belong to the library.

Pool pages and token previews reuse `useClient()` for public reads. Pool balances,
allowances, reserves, and creation reviews remain grouped application reads with
same-height checks; independent balance hooks would not preserve that guarantee.
Gas policy, artifact loading, persistence before broadcast, and queue processing
remain application-owned. Receipt polling and network checks use client 0.17.0.

### Reading and writing contracts

Both apps use React 0.4.0 and the same `src/transactions/use-transactions.ts`
entry point. It combines the current wallet with public receipt queries from
`transactionReceiptQueryOptions`. Recovery shares committed receipts, works
without wallet permission, and only retries observation when requested.

The ERC20 adapter binds address and client once with `getContract`; each view
still returns its height for the coherent snapshot check. Single writes use
`wallet.executeAndWait` with an awaited `onSigned` persistence callback.
Queued batches keep the explicit prepare/sign boundary, then use the SDK's
`submitAndObserve`. Child budgets are summed with `walletGasLimit`; these are
calibrated limits, not gas estimates. Enqueue success still requires the later
request-completion event before displaying a completed swap.

Provisioning follows the same pattern in both apps: `prepareContractDeployment`,
prefund its predicted address, then `wallet.deployContractAndWait`. The SDK
verifies the returned address and committed execution result.
