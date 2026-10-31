# Swap

Create pools, swap tokens, and manage liquidity through
[Thruput Freighter](https://www.thruput.network/docs/tools/wallet-extension/). The registry
indexes pool creation; balances, reserves, and transaction verification use live
chain reads. Wallet keys stay in the wallet. This is a full app reference;
start with [client examples](../../examples/typescript/README.md) for smaller SDK tasks.

## Local setup

Complete [root setup](../../README.md#setup), including `npm ci`. Start
`thruput node --port 9545 --json`, or reuse the node running Launchpad. Then:

```sh
export THRUPUT_CLI="$(command -v thruput)"
export THRUPUT_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/swap
npm run dev --workspace apps/swap
```

Open **http://127.0.0.1:5174**. The dev server includes the registry and indexer.
Use the same endpoint in Freighter and request test native tokens before submitting writes.

Setup builds artifacts/bindings and deploys fresh empty infrastructure. It
writes `.env.local` and hash-named immutable public code assets. The deployer key
is not saved. Failed setup keeps the old environment. Restart the app afterward.
Use matching rebuilt contracts and bindings; old deployments do not update when
packages are installed.

## Demo pool

Set up [Launchpad](../token-launchpad/README.md#local-setup) on the same node;
its factory is used to create fresh tokens. Neither app server needs to run.

```sh
export SEED_RECIPIENT=<your-base58-wallet-address>
npm run seed --workspace apps/swap
```

Each invocation creates its own new gUSD/gEUR tokens and pool, supplies
1,000 units of each, and transfers LP tokens plus the remaining 999,000 units
of each token to the recipient. It does not reuse a prior Launchpad seed.

No signer or recovery journal is saved. A failed run stops without retrying
writes and prints its progress and transaction hashes. Start a fresh node to
discard partial demo state. See [fresh seeding](../../scripts/seed/README.md).

## Configuration and deployment

See [`.env.example`](.env.example) for settings. `THRUPUT_RPC_URL` overrides the
local loopback HTTP endpoint. `SWAP_APP_ENV`, `SWAP_ARTIFACT_ROOT`, and
`SWAP_APP_PUBLIC_DIR` override setup paths, resolved from the repo root.
The registry defaults to factory-scoped SQLite under `.local/`;
`POOL_REGISTRY_DB_PATH` overrides it. Use one writer per database.

For `setup:devnet`, set an HTTPS RPC endpoint and verified live
`THRUPUT_NETWORK_ID` (base58, as `thruput` and the explorer print it). Each run writes a fresh `.env.devnet` deployment. Use
`dev -- --mode devnet` to select it locally; supply environment values directly
when hosting with `start`. `PORT` defaults to 3000. Railway uses
`apps/swap/railway.json` and the root npm install.

Public settings load through `/api/config`; the RPC proxy permits reads only.
Token discovery can use Launchpad's public registry; configure its URL through
the settings in `.env.example`. Manual token-address entry is also available.

## Code and transaction behavior

- `src/main.tsx`, `app.tsx`, `app-providers.tsx`: startup, SDK providers, and routing.
- `src/pools/`, `src/swap/`: feature pages and forms.
- `src/contracts/`: typed contract calls and generated bindings.
- `src/transactions/`: execution, observation, account locks, and recovery.
- `src/domain/`: amount, allowance, and reservation rules.
- `server/`: registry and HTTP server; `shared/`: browser/server models.

A confirmed queued request is not a completed swap or liquidity change.
The app correlates terminal events and verifies the outcome. It preserves
transaction hashes across ambiguous submissions and reloads. Allowance cleanup
accounts for outstanding work; do not erase saved operations to bypass a lock.
Atomic batching is negotiated through wallet capabilities, with a sequential
path for wallets without it. Event decoding uses the current generated ABI;
historical event-signature aliases are not supported.

Run `typecheck`, `test`, or `build` with `--workspace apps/swap`.
Root browser, seeding, and batching checks are in the
[script guide](../../scripts/README.md#checks).
