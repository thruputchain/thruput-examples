# Token faucet

An internal devnet faucet for **ACORN, CLOVER, MAPLE, PEBBLE, and SPROUT**.
Each wallet address can receive **10 of each token once**. Claims transfer tokens
from the faucet account's existing supply. The server signs and pays for each
transfer; the recipient does not sign a transaction.

The [deployment manifest](deployments/devnet.json) records the five existing
tokens, their network, and the faucet account. Each token has six decimals and
an initial supply of 1,000,000.

After claiming tokens, users select **Open Swap** to visit
<https://swap-production-66df.up.railway.app/pools>. They can trade in existing
pools or connect their wallet and create token/token pools. Pool creation is
handled by Swap, separately from the faucet.

## Run locally

From the repository root, using Node.js 22.13 or newer:

```sh
npm ci
npm run build --workspace apps/token-faucet
npm run start --workspace apps/token-faucet
```

Open **http://localhost:3002**. The server needs the existing local signer at
`apps/token-faucet/.local/devnet/signer.key`.

For frontend development, keep the server running and run
`npm run dev --workspace apps/token-faucet`. Vite serves port 5175 and proxies
`/api` to the server on port 3002.

Users can paste an address or select **Connect Wallet** in the header. Claims
can be made individually or for all five tokens. Users also need native HOG for
swap transactions and pool creation, available through the wallet's devnet
airdrop action.

## Deploy the faucet on Railway

Use the repository root as the build context and
`apps/token-faucet/railway.json` as the service configuration. It builds and starts
the faucet workspace. Attach a persistent volume at `/data` and set:

```ini
FAUCET_MANIFEST=deployments/devnet.json
FAUCET_KEY_FILE=/data/signer.key
FAUCET_STATE_DIR=/data/claims
FAUCET_SWAP_URL=https://swap-production-66df.up.railway.app/pools
```

Railway supplies `PORT`; the local default is `3002`. The health check is
`/api/config`. Use the same npm package-read authentication as the other apps
to install the private Groundhog packages.

Securely copy the existing **raw 32-byte** signer from
`apps/token-faucet/.local/devnet/signer.key` to `/data/signer.key` and set its file
mode to `0600`. The key must match the account in the manifest, which owns the
faucet supply. It is a server file, not a `VITE_*` variable. Do not commit it.

The checked-in manifest already contains the devnet RPC URL, network hash, and
five token addresses. No swap factory, router, or pool database variables are
needed by the faucet. `FAUCET_SWAP_URL` changes its link at server startup without
a frontend rebuild.

The five tokens already exist. Deploying this app does not require running the
setup script again.

## Keep the existing Swap deployment

Swap's app and contract changes from the faucet experiment have been reverted.
Keep the existing Railway service variables and persistent database to preserve
the two existing pools in its directory. In particular:

```ini
VITE_GROUNDHOG_RPC_URL=https://rpc.thruput.network/
VITE_GROUNDHOG_NETWORK_ID=0xabb9cdbc56285d0e71c9845273ca06211fedf7ee2f58c43cfac6060f9402aa0f
VITE_NATIVE_HOG_ADDRESS=0x0000000000000000000000000000000000000000000000000000000000000001
VITE_SWAP_FACTORY_ADDRESS=0xd09b6848ad37e0afd7841f2d19f8315a28a27791015342d1fe381c7efe3f78a6
VITE_SWAP_ROUTER_ADDRESS=0x4762d730a050aedb33a1bf56ccc90ec2873634ccf28343f1c7d3bf64c3ce0248
VITE_POOL_TOKEN_HASH=0x152d5e4635c5322cb1fbc75e7584cd6565d8e4802c04e9c4e9b75b4e7fb90776
VITE_EXPLORER_URL=https://explorer.thruput.network
POOL_REGISTRY_DB_PATH=/data/pools-devnet-abb9cdbc.sqlite
```

Keep token discovery enabled with the existing Launchpad:

```ini
VITE_TOKEN_DISCOVERY_ENABLED=true
VITE_STANDARD_TOKEN_FACTORY_ADDRESS=0x9609d0a7e64f8daeb1e57d6617d0c8f21166f649729740258011e9c353207aec
VITE_STANDARD_TOKEN_HASH=0x2ce1fb17d0eaae09ed8ded2514f660a221d233ce60924bdcebb95a704124d7ea
TOKEN_DISCOVERY_UPSTREAM_ORIGIN=https://token-launchpad-production.up.railway.app
```

Use the existing LP-token code artifact matching `VITE_POOL_TOKEN_HASH` in the
Swap build. Keep its current contract bindings; regenerating bindings from a
different contract revision can change the liquidity-event signatures.

Create new token/token pools through the existing Swap UI. The registry will
index them automatically. Native-HOG pair support was part of the reverted
work and is not included in this setup.

The experiment's 15 pools remain on-chain under a separate factory. Reverting
local code does not delete deployed contracts. The faucet no longer creates or
depends on those pools. Its original deployment journal retains their history.

## Claim state and recovery

Paths are relative to `apps/token-faucet` when using workspace commands.

| Setting | Default |
| --- | --- |
| `FAUCET_MANIFEST` | `deployments/devnet.json` |
| `FAUCET_KEY_FILE` | `.local/devnet/signer.key` |
| `FAUCET_STATE_DIR` | `.local/claims` |
| `FAUCET_SWAP_URL` | The manifest's `swapUrl` |
| `PORT` | `3002` |

Keep the signer and claim directory backed up. If moving an existing faucet,
move its claim records too, so users retain their one-time limits.

Claims are saved before submission. Retries check the original transaction or
submit its original bytes. A confirmed claim never sends another transfer.
An unresolved expired transaction requires operator investigation; its record
is retained to prevent a duplicate payment.

Run one server against one persistent claim directory. An exclusive SQLite lock
prevents two processes from using that directory at once. The operating system
releases the lock when the server exits, including after a crash. Leave
`server-lock.sqlite` in place; its presence does not mean a server is running.
Keep the claim records: deleting them resets the limits.

When upgrading from the older directory lock, stop the old server first. Its
empty `lock` directory is no longer used by the new server.

The limit is per address, not per person. Developers can create another address
to claim again.

Failed claims produce a structured `Faucet claim failed` server log with the
token, recipient, and recorded transaction hash when available. Journal errors
include their locally authored reason; RPC and HTTP errors include their numeric
code or status. External error messages, response bodies, causes, and signed
transaction bytes are omitted. Corrupt or unresolved journal failures direct
the user to the operator instead of suggesting that retries alone will fix them.

## Create or resume the five tokens

For a new network or token deployment, provide a deployed standard-token factory
and its matching artifact in `apps/token-launchpad/public/contract-artifacts/`.
The script reads `apps/token-launchpad/.env.devnet`; override that path with
`LAUNCHPAD_APP_ENV`.

```sh
npm run setup:devnet --workspace apps/token-faucet
```

Setup creates only the five tokens and funds their storage. It records nonces
and signed transactions in `.local/devnet/deployment.json`. Rerunning resumes
those transactions. Earlier journals with pool records can still be used; the
script only resumes their token steps.

Setup uses the same crash-released SQLite lock as the server, in its deployment
directory. A stopped setup process does not leave a stale lock. Stop any older
setup process before upgrading; its empty `lock` directory is no longer used.

Optional settings:

- `FAUCET_DEPLOY_DIR`: deployment directory; defaults to `.local/devnet` in this app
- `GROUNDHOG_RPC_URL`: devnet HTTPS RPC endpoint
- `FAUCET_SWAP_URL`: link included in the generated manifest
- `SEED_RETRY_FAILED=1`: allow a retry after an authoritative transaction failure

For a new deployment, set `FAUCET_MANIFEST` to its generated `public.json` and
`FAUCET_KEY_FILE` to its signer. Preserve both files and the setup journal.

## Checks

```sh
npm run test --workspace apps/token-faucet
npm run build --workspace apps/token-faucet
npm run test:browser --workspace apps/token-faucet
npm run test:devnet --workspace apps/token-faucet
```

The browser check uses simulated claims at desktop and mobile sizes. Chromium
defaults to `/usr/bin/chromium`; override it with `CHROMIUM_PATH`.

The live check transfers 10 of each token to a new test account and repeats each
claim to verify the limit. Run it explicitly: it sends devnet transactions.
