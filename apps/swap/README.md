# Swap

Create pools, swap tokens, and manage liquidity through
[Thruput Freighter](https://www.thruput.network/docs/tools/wallet-extension/).
Wallet keys stay in the wallet. Read the [Voting app](../voting/README.md) first:
Swap uses its transaction pattern.

**What it shows:**

- **Queued requests and cranking.** A pool cannot run two swaps in parallel,
  because each one reads and writes the reserves. So the router queues
  requests, which can land concurrently, and a later "crank" transaction
  processes the queue in one batch. The
  [swap contracts README](../../contracts/swap/README.md#cranking-the-queue)
  explains why.
- **Lists in the contract.** The swap factory keeps a list of its pools
  (`all_pairs_length` and `pair_at`), because pools are created rarely. The app
  reads it directly and needs no indexer. Compare
  [Launchpad](../token-launchpad/README.md), whose factory does not keep a list.
- **Atomic batches.** Exact approvals and the request go in one transaction.

**Contracts:** the [swap](../../contracts/swap/README.md) project, and
[ERC20](../../contracts/erc20/README.md) for each pool's LP token.

## Local setup

Complete [root setup](../../README.md#setup), including `npm ci`. Start
`thruput node --port 9545 --json`, or reuse the node running Launchpad. Then:

```sh
npm run setup:local --workspace apps/swap
npm run dev --workspace apps/swap
```

Open **http://127.0.0.1:5174**.
Use the same endpoint in Freighter and request test native tokens before submitting writes.

Setup builds artifacts/bindings and deploys fresh empty infrastructure. It
writes `.env.local` and hash-named immutable public code assets. Setup saves its
private deployer key and transaction outcomes under `.local/swap-setup/run-*`,
beside the environment output. App configuration contains only public values.
Failed setup keeps the old environment. Restart the app afterward.
Use matching rebuilt contracts and bindings; old deployments do not update when
packages are installed.

Setup funds the deployer and native-token reserve, then registers handler and
driver code. It predicts factory and router addresses before deploying them.
Each deployment funds and initializes its contract atomically. Setup checks
code hashes, both factory/router links, the funding policy, and an empty pool
registry before publishing the environment. Verification requires state at or
after the last confirmed write. Unknown transaction outcomes are recorded and
never retried.

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

See [`.env.example`](.env.example) for settings. Setup overrides:

- `THRUPUT_RPC_URL`: endpoint; defaults to `http://127.0.0.1:9545` locally and
  `https://rpc.thruput.network` for Devnet.
- `THRUPUT_NETWORK_ID`: optional expected network hash (base58).
- `THRUPUT_RUNTIME_MANIFEST`: optional manifest used to check network identity.
- `THRUPUT_CLI`: optional executable; defaults to `thruput` on `PATH`.
- `SWAP_APP_ENV`, `SWAP_ARTIFACT_ROOT`, and `SWAP_APP_PUBLIC_DIR`: output and
  artifact paths, resolved from the repository root.

Both modes use SDK network discovery when no expected hash is supplied.

Run `npm run setup:devnet --workspace apps/swap` for Devnet defaults. It uses
the same setup steps and writes a fresh `.env.devnet` deployment. Use
`dev -- --mode devnet` to select it locally; supply environment values directly
when hosting with `start`. `PORT` defaults to 3000. Railway uses
`apps/swap/railway.json` and the root npm install.

Public settings load through `/api/config`; the RPC proxy permits reads only.

## Where the Thruput code is

- [`src/contracts/swap.ts`](src/contracts/swap.ts): every read (pools, reserves,
  balances, allowances) and every call (approve, swap, add and remove
  liquidity, create a pair, crank), and how a request's outcome is found.
- [`src/transactions/use-queued-request.ts`](src/transactions/use-queued-request.ts):
  one request through the queue.
  1. One batch approves the exact missing allowance and calls the router. The
     receipt's `RequestAccepted` event gives the request ID.
  2. The app sends one crank (`process_requests`). This is a second wallet
     transaction, because the queue is processed in a later transaction.
  3. The app looks for the handler's event (`SwapEvent`, `LiquidityMintEvent`,
     or `LiquidityBurnEvent`) or the driver's `RequestFailed` event that carries
     the request ID. Anyone's crank can process the request. If it is still
     queued after the app's crank, the user can crank again.
- [`src/transactions/use-wallet-transaction.ts`](src/transactions/use-wallet-transaction.ts):
  send a batch through the wallet, save it before broadcast, and observe it
  after a reload (the Voting pattern).
- [`src/pools/create-pool-page.tsx`](src/pools/create-pool-page.tsx): create a
  pair and add its first liquidity in one transaction. The LP token's code is
  deployed in the same transaction.

Token search in "Create pool" calls the Launchpad app's `GET /api/tokens`. On
the hosted site both apps share one origin. Locally, the Swap dev server
forwards `/launchpad/api` to the Launchpad dev server on port 5173. If
Launchpad is not running, paste a token address instead.

The server only serves public configuration (`/api/config`), a read-only RPC
proxy (`/thruput-rpc`), and the built app.

## What this example leaves out on purpose

- One request at a time, per account, in one browser tab.
- One price tolerance (1%). The minimum output protects a swap if the price
  moves before the queue is processed.
- No allowance cleanup. Each request approves only the missing amount. If a
  request fails, its allowance stays; the next request uses it.
- No routing across several pools, and no price charts.
- No guard against switching wallet accounts while a request's outcome is
  being read. The app can then miss showing that outcome; the pool's balances
  still reflect it.
- One page size for the event walk: 200 events, which the devnet RPC allows. An
  endpoint that allows fewer rejects the walk.
- No check that the RPC endpoint keeps serving the same network. The SDK checks
  the network when the app starts; an endpoint that later switches networks is
  a deployment fault.
- No handling of receipt results the SDK does not recognize yet. Only a
  `return` counts as success; any other committed result shows as failed.

## Checks

```sh
npm run typecheck --workspace apps/swap
npm test --workspace apps/swap
npm run test:swap
npm run test:launchpad-swap
```

`test:swap` starts an isolated node and checks both setup modes, pool creation,
liquidity processing, and a swap at the contract level.
`test:launchpad-swap` drives both apps in Chromium with a test wallet: it
launches two tokens, creates a pool from Launchpad's link, swaps, adds
liquidity across a reload, and removes liquidity. Set `THRUPUT_CLI`,
`THRUPUT_DEVNODE_BINARY`, and `CHROMIUM_PATH` as described in the
[script guide](../../scripts/README.md#checks).
