# Token Faucet

A small reference app for server-side token transfers with the published
TypeScript SDK. React, Vite, TanStack Query, and a Node HTTP server follow the
other apps in this repository. SQLite stores claims and transaction evidence.

Paste a wallet address to receive one atomic starter pack. No wallet signature
is needed. The faucet distributes test assets, not native tokens. Native funding
for swaps remains separate.

| Test asset | Decimals | Per claim |
| ---------- | -------: | --------: |
| tUSDC      |        6 |     1,000 |
| tEURC      |        6 |     1,000 |
| tBTC       |        8 |      0.01 |
| tETH       |        8 |       0.1 |
| tSOL       |        9 |         5 |
| tDOGE      |        8 |     1,000 |

These are independent test tokens, not bridged or redeemable assets. Setup seeds
five pools against tUSDC, each with 1,000 starter packs of each side. These ratios
are test fixtures, not market prices. Setup leaves at least 10,000 packs in the
faucet. Native storage funding can limit the available pack count first.

## Local development

Complete the root README setup. Start a local node and set `THRUPUT_CLI`,
`THRUPUT_RUNTIME_MANIFEST`, and `THRUPUT_RPC_URL`. Then, from the repository root:

```sh
npm run setup:local --workspace apps/token-launchpad
npm run setup:local --workspace apps/swap
npm run setup:local --workspace apps/token-faucet
npm run dev --workspace apps/token-faucet
```

Open <http://127.0.0.1:5177>. Root `npm run setup:local` and `npm run dev` also
include the faucet. Setup uses the existing Launchpad and Swap deployments and
their hash-checked artifacts. It creates six fresh tokens and five pools through
those factories; no faucet contract is needed.

Setup writes a private `.env.local` and a write-once `.local/local` directory.
That directory contains the signer, signed transactions, receipts, token list,
and pool list. Setup refuses an existing directory or environment file. To create
a separate deployment, set `FAUCET_SETUP_DIR` and `FAUCET_ENV_PATH` to new paths.
Do not delete a stopped run: inspect its transaction evidence first.

To use separate Launchpad or Swap fixtures, set `LAUNCHPAD_APP_ENV`,
`LAUNCHPAD_APP_PUBLIC_DIR`, `SWAP_APP_ENV`, and `SWAP_APP_PUBLIC_DIR`.

```sh
npm run test --workspace apps/token-faucet
npm run build --workspace apps/token-faucet
```

With a running isolated local deployment, `npm run test:local --workspace
apps/token-faucet` sends a real claim and checks all six balances and restart
recovery. Set `FAUCET_ENV_PATH` for a separate test environment. With the app
running, `npm run test:browser --workspace apps/token-faucet` checks a real claim,
reload recovery, and mobile layouts. It needs Chromium; set `CHROMIUM_PATH` if
needed. Both commands consume a starter pack.

## Claims and recovery

- `shared/config.ts`: public token and claim types.
- `server/config.ts`: validated configuration and policy defaults.
- `server/store.ts`: quota reservations and durable claim evidence.
- `server/chain.ts`: network checks, inventory, signing, and receipt observation.
- `server/claims.ts`: one worker that processes reserved claims.
- `scripts/setup.ts`: explicit provisioning; never runs at server startup.

The server saves signed bytes and the expected hash before broadcast. A network
timeout keeps the claim pending. The worker observes the original hash after
restart; it never creates a replacement transaction or automatically resubmits.
A crash between persistence and broadcast can therefore leave a claim pending.
An operator must inspect the saved transaction before changing its state.

The browser saves the claim ID before sending the request and restores it on
reload. Repeated requests with that ID return the same claim. A second request
ID for an address with a pending claim also returns the original claim.

The pack uses one DefaultWallet batch. Native storage top-ups and all six token
transfers succeed or fail together. Only a successful receipt marks it confirmed.
Network ID and a saved block checkpoint protect against network resets.

## Limits and retained data

Defaults: one claim per address per 24 hours, ten claims per client network per
hour, 1,000 claims globally per rolling day, and 60 API requests per network per
minute. IPv4-mapped IPv6 uses the IPv4 limit; other IPv6 addresses share a /64.
Pending claims remain reserved against quotas, even after the window expires.
Failed claims also consume quotas. There is at most one pending claim per address
and 100 pending claims in total.

Set `FAUCET_COOLDOWN_SECONDS`, `FAUCET_IP_CLAIMS_PER_HOUR`,
`FAUCET_CLAIMS_PER_DAY`, or `FAUCET_REQUESTS_PER_MINUTE` to change these limits.
The global claim cap also caps each token's payout at its claim amount multiplied
by that limit. Records are bounded at 10,000; the service stops accepting claims
when full.

Raw IP addresses are not stored. The server stores a salted HMAC of the normalized
client network. Keep `FAUCET_IP_SALT` stable across restarts. Terminal claims,
including addresses and signed bytes, are removed after seven days and the end
of their cooldown during new-claim processing. Unresolved evidence is retained.
Request-rate records expire after one minute. SQLite deletion does not promise
secure erasure from backups or storage media.

## Devnet and Railway

Run `setup:devnet` with the existing devnet Launchpad/Swap environments and a
funded `FAUCET_SIGNING_PRIVATE_KEY`. The script does not request native funding
on devnet. Keep the signer private; use a dedicated test-only account.

Use `railway.json`, one replica, and a persistent volume mounted at `/data`.
Set `FAUCET_DB_PATH=/data/claims.sqlite`, `PORT=3000`, and build with
`APP_BASE_PATH=/faucet/`. Copy the other generated environment settings into
Railway variables. Set `SWAP_APP_URL=https://examples.thruput.network/swap/`.
Do not run overlapping instances against the same database. Preserve the database,
signer, salt, and asset configuration on redeploy.

Route through the existing examples gateway. Set the same `FAUCET_PROXY_SECRET`
on the gateway and faucet, and set `FAUCET_UPSTREAM` to the private service host.
The gateway replaces the internal client-IP header with Railway's `X-Real-IP`.
This assumes the gateway is reached through Railway's public edge, which sets
that header. Do not expose this gateway listener directly on another network
without adapting its trusted-edge configuration. The faucet rejects requests
without the gateway secret; direct local development uses the socket peer.

Before publishing, confirm the claim quantities and limits above, native funding,
database persistence, and the deployment's proxy headers. Verify that spoofed
`X-Forwarded-For` and `X-Faucet-Client-IP` headers cannot bypass IP quotas.
