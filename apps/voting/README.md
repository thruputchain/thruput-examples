# Voting app

Create multi-question polls, vote with a wallet, and read public live results.
This is a localnode-only teaching app for the [Voting contract](../../contracts/voting/README.md).

## Local setup

Complete [repository setup](../../README.md#setup) and run `npm ci` from the root.
Use CLI 0.35.0 with runtime 0.1.31-rc.12 (native wire 14). Voting uses client
0.23.0, React SDK 0.7.0, and protocol packages 0.18.0, matching the other apps.
Start a local node in another terminal:

```sh
~/Work/thruput-tools/target/debug/thruput node --port 9545 --json
```

Use its printed runtime manifest:

```sh
export THRUPUT_CLI="$HOME/Work/thruput-tools/target/debug/thruput"
export THRUPUT_RPC_URL=http://127.0.0.1:9545
export THRUPUT_RUNTIME_MANIFEST=/path/printed/by/node/runtime-manifest.json
npm run setup:local --workspace apps/voting
npm run dev --workspace apps/voting
```

If you installed the CLI elsewhere, set `THRUPUT_CLI` to that executable.
Open **http://127.0.0.1:5176**. Connect
[Thruput Freighter](https://github.com/thruputchain/freighter) to the same localnode
and request test native tokens in the wallet. Public browsing needs no wallet.

Setup builds the contract, generates bindings, deploys a fresh empty Voting
contract, and writes `.env.local` only after success. It does not save the
disposable deployer key. Each invocation creates a new deployment. Restart the
app after setup. This app does not support devnet.

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

## Code map

- `src/contracts/polls.ts`: generated method calls, small snapshot-read batches,
  and input validation. Each question's counts use one snapshot.
- `src/pages/`: public discovery, voting, results, and draft management.
- `src/components/poll-editor.tsx`: explicit question and option editing.
- `src/transactions/`: one saved signed transaction and its receipt observation.
- `scripts/`: contract generation, fresh deployment, and local acceptance tests.
- `vite.config.ts`: local RPC proxy and public runtime configuration for both
  development and preview. No database or signing server is required.

Setup reads the deployer balance through the balance API and credits the contract
with 1 native token for storage. This is a finite shared reserve for a local demo; anyone
can fund the contract address if it runs low. Wallets need free native tokens for gas
capacity. Gas has no token fee; storage deposits are separate.

## Transaction recovery

The app saves signed bytes, hash, account, and network before broadcast. Web
Locks prevent two tabs from replacing the saved record. Reload and **Check
transaction** only observe the original hash, even after disconnecting.

An uncertain outcome blocks new writes. The app does not resubmit automatically.
Successful transactions clear their pending record automatically and show a short
confirmation. **Finish** acknowledges a committed execution failure.
An unfamiliar receipt execution result remains unresolved and keeps the signed record.
**Export record** preserves signed evidence. If browser storage fails, submission
stops; **Retry storage** saves the in-memory record. Then select **Submit original
transaction** to send those same signed bytes. This action checks for an existing
receipt and expiry first; it never creates or signs a replacement. A malformed saved record
blocks signing rather than silently discarding evidence.

## Checks

```sh
npm run typecheck --workspace apps/voting
npm test --workspace apps/voting
npm run build --workspace apps/voting
npm run test:local --workspace apps/voting
npm run test:browser --workspace apps/voting
```

The last two commands require the running node and the environment above. Both
deploy fresh isolated contracts without changing `.env.local`. Browser checks
also require Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`). They use a
controlled provider with disposable keys held in the test process, not in the
browser. They cover creation, voting with two wallets, closure, reload recovery,
and mobile/desktop layouts in both themes.

`npm start --workspace apps/voting` serves a local production preview on port
5176. `/api/config` supplies public settings at runtime; restart preview after
changing `.env.local`.
