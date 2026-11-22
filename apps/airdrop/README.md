# Airdrop

Claim configurable test tokens from an on-chain contract, once per wallet.
An empty eligible-address list opens the airdrop to everyone. A nonempty list
restricts it to those addresses. Rewards and eligibility are immutable after
initialization; use a new deployment for a new distribution.

**What it shows:** a one-time claim that moves several tokens atomically, and
contract views that decide what the page shows. The wallet signs and submits the
claim. The server only serves public configuration and a read-only RPC proxy.
The app needs no payout key or database.

**Contracts:** [Airdrop](../../contracts/airdrop/README.md). Local setup
creates its demo tokens with the [token factory](../../contracts/token-factory/README.md).

## Local setup

Complete [root setup](../../README.md#setup) and run `npm ci` from the root. Use
CLI 0.48.0 or newer, and start `thruput node`. Setup defaults to `http://127.0.0.1:9545`; set `THRUPUT_RPC_URL`
for another endpoint.
From the repository root:

```sh
npm run setup:local --workspace apps/token-launchpad
npm run setup:local --workspace apps/swap
npm run setup:local --workspace apps/airdrop
npm run dev --workspace apps/airdrop
```

Open <http://127.0.0.1:5177>, connect Thruput Freighter to the same local node,
and request native test tokens in the wallet before claiming. Native tokens
provide transaction scheduling capacity; they are separate from these assets.
Root `npm run setup:local` and `npm run dev` also include Airdrop.

Generation uses `thruput` on `PATH`; `THRUPUT_CLI` can select another executable.
Setup discovers the network through the SDK. `THRUPUT_NETWORK_ID` and
`THRUPUT_RUNTIME_MANIFEST` are optional network checks. Both modes use
`scripts/index.ts`, with `--network local` or `--network devnet`.

Default setup creates seven test tokens, seeds six pools against tUSDC, and funds
an open airdrop with 1,000 claims. Each pool contains 1,000 claims' worth of each
side. These are demo ratios, not market prices.

| Token | Decimals | Per claim |
| ----- | -------: | --------: |
| tUSDC |        6 |     1,000 |
| tEURC |        6 |     1,000 |
| tBTC  |        8 |      0.01 |
| tETH  |        8 |       0.1 |
| tXLM  |        7 |     1,000 |
| tUSDT |        6 |     1,000 |
| tXAUM |        8 |       0.1 |

## Configure a distribution

Set `AIRDROP_ADDRESSES_FILE` to a JSON file containing an array of base58 wallet
addresses. Omit it or supply `[]` for open eligibility. Up to 256 addresses are
supported. This list is sent to the contract, not checked only by the UI.

Set `AIRDROP_TOKENS_FILE` to use existing tokens instead of creating demo assets:

```json
[
  {
    "address": "REPLACE_WITH_TOKEN_ADDRESS",
    "symbol": "TEST",
    "name": "Test Token",
    "decimals": 6,
    "claimAmount": "1000000"
  }
]
```

Use 1–16 unique token addresses. `claimAmount` is a positive integer in raw units:
`1000000` means one token with six decimals. Setup verifies symbols, decimals,
and the deployer's available token balance. Custom-token setup creates no tokens
or pools. Set `AIRDROP_DEPLOYER_PRIVATE_KEY` privately to a signer that holds the
selected tokens. In either mode, setup requests faucet funding if the signer's
native balance is too low. A sufficiently funded signer skips the faucet.

`AIRDROP_PACKS` sets the number of claims funded by setup, from 1 to 10,000,
default 1,000. Native storage funding scales with this budget, the allowlist,
contract size, and the network's reported storage costs. Each reward token also
receives storage funding for new recipient balance rows.
An open airdrop can be depleted by someone using many addresses.
The funded token budget bounds distribution; there is no IP limit or daily cap.

Setup writes `.env.local` or `.env.devnet` after it verifies rewards, balances,
and eligibility. It preserves an existing environment because that file identifies
a funded distribution. Set `AIRDROP_ENV_PATH` to a new path for a new distribution.
The environment contains no signer key.

Each run creates a private `run-*` directory under `.local/airdrop-setup/` beside
the output environment. `AIRDROP_SETUP_DIR` selects another parent directory.
Setup uses [`@thruputchain/testkit`](https://www.npmjs.com/package/@thruputchain/testkit),
with one named step for each transaction. The run directory contains:

- `key.json`: a generated deployer key, saved before funding. A supplied
  `AIRDROP_DEPLOYER_PRIVATE_KEY` is not copied to disk.
- `transactions/report.json`: the public record of each step and transaction,
  with its outcome (`succeeded`, `failed`, `notSubmitted`, or `unknown`) and its
  hash when one is known.
  The `check-network` step records the block-one checkpoint.
- `transactions/evidence/`: private signed transactions, saved before broadcast.
- `tokens.json` and `pools.json`: demo assets created so far.

Before each broadcast, setup checks the network hash and the block-one checkpoint,
so it detects a chain reset. Keep the files from interrupted runs. If a send
response is lost, setup observes the signed transaction instead of sending it
again; a transaction still unconfirmed when the wait ends stays `unknown`.
`reconcileRun("<run>/transactions", client)` observes the original transactions
again without sending them. If a funding attempt has no hash, call the faucet's
`requestAirdropAttempt` with the `clientNonce` saved in its intent, never a new
nonce: a new nonce can fund twice.

For separate demo fixtures, use `LAUNCHPAD_APP_ENV`, `LAUNCHPAD_APP_PUBLIC_DIR`,
`SWAP_APP_ENV`, and `SWAP_APP_PUBLIC_DIR`. All paths are relative to the repo root.

## Where the Thruput code is

- [`src/claim.ts`](src/claim.ts): build the claim with the generated binding,
  save it before broadcast, and observe it after a reload. It follows the
  [Voting app's transaction pattern](../voting/README.md#the-transaction-pattern).
- [`src/app.tsx`](src/app.tsx): contract views (`config`, `eligible`,
  `hasClaimed`) and ERC20 balance reads.

**Check again** looks the hash up, and clears the record when the chain passes
the claim's expiry height without committing it; then the wallet can claim
again. The contract itself prevents a second claim from the same wallet.

## What this example leaves out on purpose

- One claim at a time, in one browser tab. There are no cross-tab locks.
- No rate limits, IP checks, or proof of unique people. The funded token budget
  bounds the distribution.
- No guard against switching wallet accounts in the moment between the
  checkpoint read and the wallet prompt.
- No check that the RPC endpoint keeps serving the same network. The SDK checks
  the network when the app starts; an endpoint that later switches networks is
  a deployment fault.
- No handling of receipt results the SDK does not recognize yet. Only a
  `return` counts as success; any other committed result shows as failed.

## Tests

```sh
npm run test --workspace apps/airdrop
npm run build --workspace apps/airdrop
npm run test:airdrop
```

`test:airdrop` starts an isolated node and creates temporary Launchpad, Swap, and
Airdrop deployments. Generate their bindings and artifacts first. Set
`THRUPUT_DEVNODE_BINARY` to a compatible runtime and `THRUPUT_CLI` if needed.
The check covers reward balances, repeat claims, existing-token allowlists,
configuration mismatches, and output preservation. Its injected browser wallet
checks signatures, reload recovery, light/dark colors, and mobile layouts.
It requires Chromium; set `CHROMIUM_PATH` if needed.
Contract tests cover allowlisted eligibility, rollback, and concurrent claims.

## Devnet and Railway

Run `npm run setup:devnet --workspace apps/airdrop` with the desired configuration
files. Demo setup creates a fresh signer and requests faucet funding by default.
It needs Devnet Launchpad and Swap environments and matching contract artifacts.
Existing-token setup requires the token owner's signer, as described above.

Use the repository root as the Railway build context, `apps/airdrop/railway.json`
as the configuration reference, `PORT=3000`, and `/healthz` for health checks.
Build with `APP_BASE_PATH=/airdrop/`. Copy the generated public environment
settings into service variables. No volume or runtime signer is needed.
The gateway routes `/airdrop/` to `airdrop.railway.internal:3000`; override with
`AIRDROP_UPSTREAM` if needed. Local development uses `/` and needs no gateway.

The old `apps/token-faucet/` private local files are preserved and ignored.
They describe the retired server-side faucet and are not used by Airdrop.
