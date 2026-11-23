# Voting app

Create multi-question polls, vote with a wallet, and read public live results.
This teaching app uses the [Voting contract](../../contracts/voting/README.md)
on a local node or devnet.

**What it shows:** a browser wallet signs each transaction; the app reads
contract views in batches; and a saved transaction survives a reload. It is the
smallest wallet app here, and the other wallet apps copy its transaction
pattern.

**Contracts:** [Voting](../../contracts/voting/README.md).

## Local setup

Complete [repository setup](../../README.md#setup) and run `npm ci` from the root.
Use CLI 0.47.0 or newer with its compatible managed runtime. Voting uses client
0.28.0, React SDK 0.11.0, and protocol packages 0.20.0, matching the other apps.
Start a local node in another terminal:

```sh
thruput node --port 9545 --json
```

In the setup terminal:

```sh
npm run setup:local --workspace apps/voting
npm run dev --workspace apps/voting
```

Open **http://127.0.0.1:5176**. Connect
[Thruput Freighter](https://www.thruput.network/docs/tools/wallet-extension/) to the same localnode
and request test native tokens in the wallet. Public browsing needs no wallet.

Setup builds the contract and bindings, creates a named Voting Deployer and bound
wallet, then funds the account. Contract funding and deployment happen in one
transaction. Voting has no initializer. Setup checks that the poll count is zero
using a snapshot that includes the confirmed deployment, then writes `.env.local`
atomically. A failed setup keeps the previous environment. Each run creates a
fresh deployment. Restart the app after setup.

No environment variables are required. Override `THRUPUT_RPC_URL` to change the
endpoint (default `http://127.0.0.1:9545`). `VOTING_APP_ENV` selects the environment
output; `VOTING_ARTIFACT` selects the compiled artifact. Paths resolve from the repo
root. Generation uses `thruput` from `PATH`; `THRUPUT_CLI` optionally overrides it.

The SDK discovers network identity. Set `THRUPUT_NETWORK_ID` or
`THRUPUT_RUNTIME_MANIFEST` to check an expected network. If both are supplied,
their network hashes must agree.

### Setup records

Each run prints its directory under `.local/voting-setup/`, beside the environment
output. `manifest.json` contains public addresses and transaction records;
`key.json` stores the private deployer key separately. Both files are readable
only by the owner. The app does not need the deployer key.

`record()` saves intent before each operation and distinguishes confirmed, failed,
and unknown outcomes. It does not retry an uncertain submission. Inspect the
original transaction hash before starting another run.

## Use it

1. Select **Create poll**, enter questions and options, then **Save draft**.
2. After confirmation, find the poll under **My polls**.
3. Review or edit the draft. **Open poll** freezes all questions and options.
4. Share the poll link. Voters submit each question separately and may return
   for unanswered questions while voting is open.
5. The admin selects **Close poll** to stop voting permanently.

Every wallet has one final answer per question. The admin can vote too.
Multiple wallets can belong to one person. Answers and results are public
on-chain. Percentages use the number of answers to that question; participants
count distinct wallets across the poll.

Polls load in pages of 12, newest first. Status and **My polls** filters apply
to the current page. Use **Older** to check earlier polls.

## Where the Thruput code is

- [`src/contracts/polls.ts`](src/contracts/polls.ts): calls built with the
  generated binding, and views read in one `readViews` batch.
- [`src/transactions/use-transaction.ts`](src/transactions/use-transaction.ts):
  sign, save, send, and observe one wallet transaction.
- [`src/transactions/pending.ts`](src/transactions/pending.ts): the saved record.

The rest is ordinary app code: `src/pages/` and `src/components/` hold the UI,
`server/` serves the public configuration and a read-only RPC proxy, and
`scripts/` holds setup.

## The transaction pattern

1. Build the invocation with the generated binding, for example
   `methods.vote.invocation(address, GAS, { id, question, option })`.
2. Send it with the React SDK's `useExecute`. The wallet signs it.
3. In `onSigned`, save the hash and the signed bytes to `localStorage`. The
   SDK waits for this before the wallet broadcasts the transaction.
4. `useWaitForTransactionReceipt` watches that hash, also after a reload.
5. When the receipt arrives, clear the saved record and refresh the reads.

A timeout does not mean the transaction failed, so the app never signs a new
one on its own. **Check again** looks the hash up. **Retry saved transaction**
sends the same signed bytes: they have the same hash, so the transaction can
commit at most once. The app clears the record only when a receipt exists, or
when the chain passes the transaction's expiry height without one. See
[When a write times out](../../examples/typescript/README.md#when-a-write-times-out).

Setup credits the contract with 1 native token for storage. Wallets need free
native tokens for gas capacity. Gas has no token fee; storage deposits are
separate.

## What this example leaves out on purpose

- One transaction at a time, in one browser tab. There are no cross-tab locks.
- No export of the saved record, and no repair of damaged browser storage.
- No indexer. The app pages through polls with the contract's `count` and
  `get_poll` views.

## Checks

```sh
npm run typecheck --workspace apps/voting
npm test --workspace apps/voting
npm run build --workspace apps/voting
npm run generate:contracts --workspace apps/voting
npm run test:voting
```

Run these commands from the repository root. `test:voting` starts an isolated
local node and deploys one fresh contract for the contract and browser checks.
It writes configuration and screenshots to a temporary directory and closes its
node, server, and browser on exit. Your app's `.env.local` is not changed.

The live check requires Linux, a compatible CLI/runtime, and Chromium
(`CHROMIUM_PATH`, default `/usr/bin/chromium`). It uses `thruput` from `PATH` by
default; `THRUPUT_CLI` and `THRUPUT_DEVNODE_BINARY` can select compatible binaries.
The controlled wallet provider holds disposable signing keys in the test process,
not in the browser. Checks cover contract permissions and input limits, poll
creation, voting with two wallets, closure, reload recovery, and mobile/desktop
layouts in both themes. See [repository checks](../../scripts/README.md#checks).

## Devnet and hosting

Both setup commands use `scripts/index.ts`. Only the default RPC URL and output
file differ. Devnet defaults to `https://rpc.thruput.network`; the same RPC
override and optional network checks apply. Run:

```sh
npm run setup:devnet --workspace apps/voting
npm run dev --workspace apps/voting -- --mode devnet
```

Setup creates a fresh empty contract and writes the ignored `.env.devnet`.
For production, supply those values as server environment variables, run
`npm run build --workspace apps/voting`, then `npm start --workspace apps/voting`.
The server binds to `0.0.0.0`; generated environments set `PORT=3000`.
Without an explicit `PORT`, the server defaults to 5176.
`/api/config` supplies public settings and `/healthz` checks configuration readiness.
The RPC proxy allows reads and simulations; wallet writes go through Freighter.

Set `APP_BASE_PATH=/voting/` at build time when serving behind the
[shared gateway](../gateway/README.md). Leave it unset for standalone local use.
