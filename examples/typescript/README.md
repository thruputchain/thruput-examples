# Small TypeScript client examples

The local-node scripts teach one operation using the published
`@thruputchain/client` package. The hosted firehose consumer uses only Node
built-ins and connects to a separate service from the JSON-RPC gateway.
No browser, Freighter, app server, or registry database is required.
The SDK repository's own examples exercise its source checkout; these exercise
the packages installed by this repository.

## Setup

Follow [Setup](../../README.md#setup) for package access and
CLI installation. Run everything here from the repository root.
For the [hosted firehose consumer](#7-consume-the-hosted-firehose), only the
repo npm install is needed; skip the CLI and local-node setup below.

In terminal A:

```sh
thruput node --port 9545 --json
```

In terminal B:

```sh
npm ci
export THRUPUT_RPC_URL=http://127.0.0.1:9545
```

The SDK scripts accept only loopback HTTP endpoints and check the localnet network
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
request needs no signer or contract build. Try adding `client.getVersionInfo()` and
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

## 4. Use a post-quantum (ML-DSA-65) account

Source: [pq-account.ts](pq-account.ts).

```sh
npm run example:pq-account
```

An ML-DSA-65 key is a pubkey account just like an Ed25519 key. The only
difference in the script is which signer creates the account:

```ts
createPubkeyAccount({ signer: new Ed25519Signer(randomBytes(32)) }); // Ed25519
createPubkeyAccount({ signer: MlDsa65Signer.fromSeed(randomBytes(32)) }); // ML-DSA-65
```

Both accounts then go through the same `fundAndTransfer` function: airdrop,
DefaultWallet transfer of **0.0001 HOG**, and a committed receipt. The script
checks that the shared recipient received both transfers.

Expected: an `ed25519` and an `mlDsa65` entry, each with its sender address and
transaction hash, plus `transferredRawEach: "1000"` and the recipient balance.
Both addresses are ordinary 32-byte account addresses; the ML-DSA-65 one is
derived from the scheme-tagged public key hash, so an Ed25519 and an ML-DSA-65
key never share an address.

The SDK handles the differences for you. The transaction's auth claim names the
key by hash, and the signed envelope carries the full public key (1,952 bytes)
and signature (3,309 bytes) instead of Ed25519's 32 and 64. Transaction hashes
cover only the unsigned body, as for Ed25519.

The CLI follows the same pattern. Only key generation takes a scheme:

```sh
thruput keys generate pq --scheme mldsa65   # prints the account address
thruput keys use pq                         # sign with it, as with any key
thruput airdrop pq --amount 25
thruput transfer <recipient> 1.5
thruput tx list pq
```

ML-DSA-65 keys have no G/S StrKey form; `thruput keys export` prints the 32-byte
seed in base58. Browser wallets such as Freighter do not yet hold ML-DSA-65 keys.

Try making the recipient an ML-DSA-65 account as well. Receiving needs no
change either: only the signer that creates the account differs.

## 5. Deploy and call Counter

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

## 6. Read events

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

## 7. Submit a batch and prove rollback

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

## 7. Consume the hosted firehose

Source: [consume-firehose.ts](consume-firehose.ts).

```sh
npm run example:consume-firehose
```

This long-running consumer subscribes at tip and writes each block record to
`<height>.xdr`, with a durable `cursor.json` checkpoint. Expected: one JSON line
per processed block with `height` and `bytes`. Saved records are output, not
commitment verification. It uses only Node built-ins (including global
`WebSocket`), needs no local node, and requires no npm authentication beyond
the repo install.

- `FIREHOSE_URL`: WebSocket endpoint; defaults to `wss://firehose.thruput.network`.
- `OUTPUT_DIR`: records and checkpoint directory; defaults to `./firehose-output`.
  Run only one consumer per output directory.

Stop with Ctrl-C and rerun with the same endpoint and output directory to
resume from the saved inclusive height. The cursor is saved before writing
each record and advanced after `firehose_ack`; replay overwrites the same
height's file. Transport loss reconnects after 2 seconds from saved progress.
A `closed` notification or `below_window` error stops the consumer with a nonzero
exit status. For `below_window`, recover state or explicitly choose a new output
directory to start at tip. A saved checkpoint cannot be reused with a different
endpoint.

See the [firehose consumption guide](https://docs.thruput.network/guides/consume-the-firehose/).

## Supporting code

- `local-client.ts` shares endpoint selection and localnet client creation.
- `wait-for-view.ts` handles the gap between a committed receipt and an available
  read snapshot. Calls specify `minStateBlockHeight`; only `StateHeightUnavailable` is
  retried, for at most 15 seconds. It never retries signing or submission.
- `generate.sh` builds the artifact and matching binding.
- `generated/counter.ts` is generated, not a hand-written teaching example.

Scripts exit nonzero on errors. A submission timeout does not prove failure.
Investigate the original hash instead of repeating a write on that assumption.

## Verification and next steps

`npm run typecheck` includes these scripts. For maintainers, `npm run test:examples`
runs the SDK scripts against a fresh isolated node and checks the results; it
does not run the hosted firehose consumer. See
[Development checks](../../scripts/README.md#checks).

Next: [Counter app](../../apps/counter/README.md) for concurrent requests, or
[Launchpad](../../apps/token-launchpad/README.md) for browser-wallet integration.
