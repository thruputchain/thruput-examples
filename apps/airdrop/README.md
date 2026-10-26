# Airdrop

Claim configurable test tokens from an on-chain contract, once per wallet.
An empty eligible-address list opens the airdrop to everyone. A nonempty list
restricts it to those addresses. Rewards and eligibility are immutable after
initialization; use a new deployment for a new distribution.

The app follows the existing React, Vite, TanStack Query, and published Thruput
SDK patterns. The server exposes public configuration and a read-only RPC proxy.
The wallet signs and submits claims. No payout key, SQLite database, IP tracking,
or proxy secret is needed at runtime. Caddy is only used for hosted routing.

## Local setup

Follow the root setup instructions, start `thruput node`, and set `THRUPUT_CLI`,
`THRUPUT_RUNTIME_MANIFEST`, and `THRUPUT_RPC_URL`. From the repository root:

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
selected tokens and native funding. On a local node, setup can request native
funding; on devnet, fund the deployer in advance.

`AIRDROP_PACKS` sets the number of claims funded by setup, from 1 to 10,000,
default 1,000. Native storage funding scales with this budget, the allowlist,
contract size, and the network's reported storage costs. Each reward token also
receives storage funding for new recipient balance rows.
An open airdrop can be depleted by someone using many addresses.
The funded token budget bounds distribution; there is no IP limit or daily cap.

Setup writes `.env.local` or `.env.devnet` and a private `.local/<network>`
directory with deployment evidence. The environment contains no signer key.
The private provisioning directory retains the deployer key and signed evidence
for inspection. Setup refuses existing output paths. Set `AIRDROP_ENV_PATH` and
`AIRDROP_SETUP_DIR` to new paths for a separate deployment. Keep evidence from
interrupted runs and inspect original transaction hashes before proceeding.

For separate demo fixtures, use `LAUNCHPAD_APP_ENV`, `LAUNCHPAD_APP_PUBLIC_DIR`,
`SWAP_APP_ENV`, and `SWAP_APP_PUBLIC_DIR`. All paths are relative to the repo root.

## Recovery and tests

The browser saves signed evidence before submission. An uncertain outcome blocks
a new claim and is checked using its original hash after reload. Use **Retry saved
transaction** to submit the exact signed bytes through the original wallet.
Use **Check expiry** to clear an expired record after a fresh on-chain claim-state
check. A failed state check preserves the record. Confirmed receipts can be
acknowledged. The contract independently prevents repeat claims.

```sh
npm run test --workspace apps/airdrop
npm run build --workspace apps/airdrop
npm run test:local --workspace apps/airdrop
npm run test:browser --workspace apps/airdrop
```

The local and browser commands require an isolated local open airdrop and each
consumes one claim. The local check verifies all balances and rejects a repeat
claim. The browser check uses an injected test wallet to check signatures,
reload recovery, light/dark brand colors, and mobile layouts. It requires Chromium;
set `CHROMIUM_PATH` if needed. Set `AIRDROP_ENV_PATH` to select a test environment.
Contract tests cover allowlisted eligibility, rollback, and concurrent claims.

## Devnet and Railway

Run `npm run setup:devnet --workspace apps/airdrop` with a funded deployer and
the desired configuration files. Default demo provisioning also needs existing
devnet Launchpad and Swap environments and matching contract artifacts.

Use the repository root as the Railway build context, `apps/airdrop/railway.json`
as the configuration reference, `PORT=3000`, and `/healthz` for health checks.
Build with `APP_BASE_PATH=/airdrop/`. Copy the generated public environment
settings into service variables. No volume or runtime signer is needed.
The gateway routes `/airdrop/` to `airdrop.railway.internal:3000`; override with
`AIRDROP_UPSTREAM` if needed. Local development uses `/` and needs no gateway.

The old `apps/token-faucet/` private local files are preserved and ignored.
They describe the retired server-side faucet and are not used by Airdrop.
