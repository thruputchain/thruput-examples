# Token Launchpad

Create tokens through [Thruput Freighter](https://www.thruput.network/docs/tools/wallet-extension/)
and browse factory launches. The app never receives wallet keys. Read the
[Voting app](../voting/README.md) first: Launchpad uses its transaction pattern.

**What it shows:**

- **Create a contract from a contract.** The
  [standard token factory](../../contracts/token-factory/factory/README.md)
  deploys each token at an address the app predicts before signing.
- **One atomic batch.** One transaction funds the predicted address and creates
  the token. If either step fails, neither happens.
- **A small event indexer.** The factory writes no shared state when it creates
  a token, so many launches can land in the same block. To list tokens, the
  server indexes the factory's `TokenCreated` events into SQLite. Compare
  [Swap](../swap/README.md), whose factory keeps a list because pools are rare.

**Contracts:** the [token factory](../../contracts/token-factory/README.md)
project: the factory and the standard token it deploys.

## Local setup

Complete [root setup](../../README.md#setup), including `npm ci`, and start
`thruput node --port 9545 --json` in another terminal. Then:

```sh
npm run setup:local --workspace apps/token-launchpad
npm run dev --workspace apps/token-launchpad
```

Open **http://127.0.0.1:5173**. The dev server includes the token API and indexer.
Configure Freighter for the same local endpoint and request test native tokens to sign
transactions. Setup creates an empty factory, not demo tokens.

Every setup run builds contracts/bindings, deploys fresh infrastructure, and
writes `.env.local` plus immutable hash-named public artifacts. Failed setup
keeps the old environment. Setup saves its deployer key and transaction outcomes
under `.local/launchpad-setup/run-*`, beside the environment output. The key file
is private; app configuration contains only public values. Restart the app after
setup. Existing deployments need their matching artifacts and bindings.

Setup funds the deployer and native-token storage reserve, then funds, deploys,
and initializes the factory in one atomic transaction. It verifies the factory
configuration at the confirmed block height before publishing the environment.
An uncertain transaction remains recorded as unknown and is never retried.

## Demo tokens

App servers do not need to run for seeding:

```sh
export SEED_RECIPIENT=<your-base58-wallet-address>
npm run seed --workspace apps/token-launchpad
```

Each invocation creates new gUSD and gEUR tokens with six decimals and
1,000,000 units each. The recipient owns the supply and is administrator.
There is no saved signer or resume state. A failed run stops and prints known
transaction hashes; another run creates different assets. See
[fresh seeding](../../scripts/seed/README.md) for failure behavior.

To create a pool, use [Swap seeding](../swap/README.md#demo-pool), which creates
its own token pair and supplies liquidity in one run.

## Configuration and deployment

See [`.env.example`](.env.example) for settings. Setup overrides:

- `THRUPUT_RPC_URL`: endpoint override; defaults to `http://127.0.0.1:9545`
  locally and `https://rpc.thruput.network` for Devnet.
- `THRUPUT_NETWORK_ID`: optional expected network hash (base58).
- `THRUPUT_RUNTIME_MANIFEST`: optional manifest used to check network identity.
- `THRUPUT_CLI`: optional CLI executable; defaults to `thruput` on `PATH`.
- `LAUNCHPAD_APP_ENV`: environment output path.
- `LAUNCHPAD_ARTIFACT_ROOT`: compiled contract directory.
- `LAUNCHPAD_APP_PUBLIC_DIR`: public artifact output directory.

Paths resolve from the repo root. Both modes discover network identity through
the SDK and read storage costs with `getChainConfig()`. Setup checks the app's
native balance charge and token initialization budget before funding.
The indexer writes a factory-specific SQLite file under `.local/`;
`TOKEN_REGISTRY_DB_PATH` overrides it. Use one server per database file.

Run `npm run setup:devnet --workspace apps/token-launchpad` for Devnet defaults.
It creates a fresh deployment and writes `.env.devnet`. Both setup commands use
the same steps. Local token funding is 1,000,000 raw units; Devnet uses 10,000,000.
Use `dev -- --mode devnet` to select it locally. For hosting, supply environment
values to `start` (`PORT` defaults to 3000). Railway uses
`apps/token-launchpad/railway.json` and the root npm install.

Public settings load from `/api/config`, so changes need a restart/reload rather
than a rebuilt bundle. The RPC proxy is read-only; wallet writes go through the
provider. `VITE_SWAP_APP_URL` enables the Swap handoff. Configure explorer and
network settings as described in `.env.example`.

## Where the Thruput code is

- [`src/launch/use-launch.ts`](src/launch/use-launch.ts): review the factory,
  predict the address, and build the batch (fund, then `create_token`). The new
  address comes from the receipt's `TokenCreated` event.
- [`src/transactions/use-wallet-transaction.ts`](src/transactions/use-wallet-transaction.ts):
  send a batch through the wallet, save it before broadcast, and observe it
  after a reload.
- [`server/indexer.ts`](server/indexer.ts): walk `TokenCreated` events with
  `client.iterateEventPages()`, save each one by its identity, then save the
  block height reached. This follows the docs'
  [Resume without missing events](https://www.thruput.network/docs/typescript/events/).
- [`server/store.ts`](server/store.ts) and [`server/http.ts`](server/http.ts):
  one SQLite table, and `GET /api/tokens` (`q`, `creator`, `limit`, `offset`;
  newest first). Swap uses this API to search tokens.

The RPC node serves events only for a retention window. The indexer keeps them
for as long as the app needs. If the node no longer serves events the index
needs, `/healthz` reports it.

## What this example leaves out on purpose

- One launch at a time, in one browser tab.
- No sorting or full-text search. The API filters by name, symbol, address, or
  creator.
- One page size for the event walk: 200 events, which the devnet RPC allows. An
  endpoint that allows fewer rejects the walk.
- `/healthz` reports a history gap that the SDK raises as `HistoryWalkError`,
  not every form a node can report it in.
- No check that the RPC endpoint keeps serving the same network. The SDK checks
  the network when the app starts; an endpoint that later switches networks is
  a deployment fault.
- No handling of receipt results the SDK does not recognize yet. Only a
  `return` counts as success; any other committed result shows as failed.

## Checks

Run `typecheck`, `test`, or `build` with `--workspace apps/token-launchpad`.
After generating contracts, run `npm run test:token-launchpad` from the root.
It starts an isolated nonzero-network node, tests both setup modes, and creates a
token from each factory using the published artifact and exact prefunding amount.
It also checks network mismatch rejection and preservation of existing output.
Configuration and private fixture state stay in the printed temporary directory.
Set `THRUPUT_CLI` and `THRUPUT_DEVNODE_BINARY` to select compatible binaries.
Root browser, seeding, and batching checks are listed in the
[script guide](../../scripts/README.md#checks).
