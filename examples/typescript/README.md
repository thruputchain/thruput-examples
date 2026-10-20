# Small TypeScript client examples

Each script teaches one operation using the published `@thruputchain/client`
package. No browser, Freighter, app server, or registry database is required.
The SDK repository's own examples exercise its source checkout; these exercise
the packages installed by this repository.

## Setup

Follow [Setup](../../README.md#setup) for package access and
CLI installation. Run everything here from the repository root.

In terminal A:

```sh
thruput node --port 9545 --json
```

In terminal B:

```sh
npm ci
export THRUPUT_RPC_URL=http://127.0.0.1:9545
```

The scripts accept only loopback HTTP endpoints and check the localnet network
identity. Use one local node for the sequence. Local nodes share a network hash,
so that hash alone does not identify a particular local node.

Signing examples create fresh accounts with keys held only in memory. They use
local test funds; funds left in these accounts cannot be recovered after exit.
They do not save keys, change app environments, or use your Freighter wallet.

## 1. Read the chain tip

Source: [chain-tip.ts](chain-tip.ts).

```sh
npm run example:chain-tip
```

Expected: JSON with `rpcUrl`, `networkHash`, and block `height`. This read-only
request needs no signer or contract build. Try adding `client.getVersion()` and
printing the RPC implementation version.

## 2. Transfer test HOG

Source: [transfer-hog.ts](transfer-hog.ts).

```sh
npm run example:transfer-hog
```

The script creates two disposable accounts, requests airdrops, transfers
**0.0001 HOG (1,000 raw units)**, waits for commitment, and verifies the
recipient balance increased by that amount. Both accounts are funded before
the tiny transfer so it does not need to pay a fresh balance-row deposit.

Expected: sender, recipient, transaction hash, `transferredRaw: "1000"`, and
recipient balance. Copy the public `recipient` address for the next step.

Try changing `parseUnits("0.0001", 7)` to `parseUnits("0.0002", 7)` and rerun.
Keep amounts as `bigint`, not floating-point numbers.

## 3. Read a balance

Source: [view-hog-balance.ts](view-hog-balance.ts).

```sh
export THRUPUT_ADDRESS=<recipient-from-the-transfer-output>
npm run example:view-hog-balance
```

Replace the entire placeholder with the public address. Expected: `rawBalance`,
formatted `hog`, and the read's block height. This uses the SDK's generated
ERC20 view and needs no private key.

Try the sender's public address too. Its balance also reflects execution costs,
so do not assume the transfer amount is its only deduction.

## 4. Deploy and call Counter

Source: [deploy-counter.ts](deploy-counter.ts).

```sh
npm run examples:generate
npm run example:deploy-counter
```

The generator uses `thruput` on `PATH`; set `THRUPUT_CLI` to a full executable
path if needed. `examples:generate` builds the repo's Counter and generates
`generated/counter.ts` from its spec. The artifact is
`target/thruput/counter.rv32a`. Rebuild both together after contract changes;
do not edit the generated file by hand.

The example creates a signer, funds it, predicts the contract address, deploys
and initializes Counter to **42**, increments by **5**, and verifies **47**.
Funding and initialization share the deployment transaction. It then emits a
`PingEvent` with tag **7** for the next example.

Expected: `value: "47"`, a public `contractAddress`, and transaction hashes.
Each known transaction hash is also printed to stderr immediately after its
SDK call returns, before the next step. Earlier hashes remain available if a
later write or readback fails; stdout keeps the final JSON result.
Each run deploys a new Counter. Copy `contractAddress` into:

```sh
export THRUPUT_COUNTER_ADDRESS=<contractAddress-from-the-output>
```

The 1-HOG storage reserve and gas limits are local example budgets, not general
deployment estimates. Try changing the initial value and increment, including
the expected-value assertion.

## 5. Read events

Source: [read-events.ts](read-events.ts).

```sh
npm run example:read-events
```

Expected after a fresh deployment: `count: 1` and `tags: ["7"]`. The script
filters by generated event signature and contract address, pages backward from
the current tip, and decodes named topics through the generated descriptor.
An empty event page alone does not mean the query is exhausted; an empty cursor
does. Results are newest first.

Try changing the tag emitted by `deploy-counter.ts` and run it again. Update
`THRUPUT_COUNTER_ADDRESS` to the new deployment before querying its events.

## 6. Submit a batch and prove rollback

Source: [batch-counter.ts](batch-counter.ts).

```sh
npm run example:batch-counter
```

Counter allows calls from the new signer created by this script. The first batch
increments by 5 and decrements by 2 in one native DefaultWallet transaction.
The second increments by 5 and then calls Counter's deliberate error method.
The script checks the reverted receipt and confirms the increment rolled back.

Expected after the deployment example:

```json
{ "before": "47", "after": "50", "afterRollback": "50" }
```

The output also includes both hashes. Rerunning adds another 3 to the counter;
it is not a read-only command. Use a dedicated Counter with no concurrent
writers while checking exact values. This is a native local-account batch,
not browser-wallet capability negotiation.

## Supporting code

- `local-client.ts` shares endpoint selection and localnet client creation.
- `wait-for-view.ts` handles the gap between a committed receipt and an available
  read snapshot. Calls specify `minHeight`; only `ViewHeightUnavailable` is
  retried, for at most 15 seconds. It never retries signing or submission.
- `generate.sh` builds the artifact and matching binding.
- `generated/counter.ts` is generated, not a hand-written teaching example.

Scripts exit nonzero on errors. A submission timeout does not prove failure.
Investigate the original hash instead of repeating a write on that assumption.

## Verification and next steps

`npm run typecheck` includes these scripts. For maintainers, `npm run test:examples`
runs them against a fresh isolated node and checks the results. See
[Development checks](../../scripts/README.md#checks).

Next: [Counter app](../../apps/counter/README.md) for concurrent requests, or
[Launchpad](../../apps/token-launchpad/README.md) for browser-wallet integration.
