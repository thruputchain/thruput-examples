# Examples gateway

Caddy serves the index page and routes each app through Railway's private network.
The public URL is https://examples-gateway-production.up.railway.app/.

| Public path   | Service          | Private upstream                        | Build-time `APP_BASE_PATH` |
| ------------- | ---------------- | --------------------------------------- | -------------------------- |
| `/`           | Examples Gateway | —                                       | —                          |
| `/counter/`   | Counter          | `counter.railway.internal:3000`         | `/counter/`                |
| `/launchpad/` | Token Launchpad  | `token-launchpad.railway.internal:3000` | `/launchpad/`              |
| `/swap/`      | Swap             | `swap.railway.internal:3000`            | `/swap/`                   |
| `/voting/`    | Voting           | `voting.railway.internal:3000`          | `/voting/`                 |
| `/airdrop/`   | Airdrop          | `airdrop.railway.internal:3000`         | `/airdrop/`                |

The gateway removes the path prefix before forwarding. Browser routes, API
requests, workers, fonts, and contract artifacts retain the prefix in public URLs.
Build each app with the path in the table. The app servers handle internal routes
at `/`; their standalone domains are not entrypoints for subpath builds.
Local Vite development uses `/` by default and needs no gateway.

## Railway settings

Use the repository root as the build context for every service. App build commands
are `npm run build --workspace apps/<app>`; start commands are
`npm run start --workspace apps/<app>`. Use Node 22.13 or newer, `PORT=3000`, and
`/healthz` as the health check. The root `railpack.json` excludes private local files.

The gateway uses `apps/gateway/Dockerfile`, `PORT=8080`, and `/healthz`.
`COUNTER_UPSTREAM`, `LAUNCHPAD_UPSTREAM`, `SWAP_UPSTREAM`, `VOTING_UPSTREAM`, and `AIRDROP_UPSTREAM`
can override its upstream addresses. Watch each app's directory plus the root
`package.json`, `package-lock.json`, `.npmrc`, and `railpack.json` for deployments.

All six services follow `main`.

The existing `railway.json` files describe the service settings for older Railway
workflows. Railway now rejects newly assigning a config-file path through its API;
configure the build/start/health settings directly in the service settings.

Keep one replica for Counter's in-memory faucet cooldown and each SQLite indexer.
Launchpad and Swap retain their `/data` volumes. Use a new factory-specific database
filename for each new deployment, so the previous registry remains intact.
Voting and the gateway need no volume.

Airdrop uses an on-chain contract for eligibility and claims. Its web server
serves public configuration and a read-only RPC proxy; it needs no signing key,
database, volume, or shared gateway secret. See [Airdrop](../airdrop/README.md)
for configurable token rewards, eligible addresses, and deployment settings.

Set Swap's token discovery variables to Launchpad's network, factory address,
and token code hash. In Railway, set
`TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://token-launchpad.railway.internal:3000`.
Set Launchpad's `VITE_SWAP_APP_URL` to the public URL ending in `/swap/`.
The internal discovery URL stays the same when the public domain changes.

## Contract releases

Build contracts and generated bindings together with the selected CLI:

```sh
export THRUPUT_CLI="$(command -v thruput)"
npm run generate:contracts --workspaces --if-present
export THRUPUT_RPC_URL=https://rpc.thruput.network
export THRUPUT_NETWORK_ID=<verified-live-base58-network-hash>
npm run setup:devnet --workspace apps/counter
npm run setup:devnet --workspace apps/token-launchpad
npm run setup:devnet --workspace apps/swap
npm run setup:devnet --workspace apps/voting
```

Each setup creates fresh contracts. It writes `.env.devnet` after verifying the
deployment. Retain transaction hashes and inspect the original transaction if a
submission has an uncertain outcome. Do not rerun setup to resolve a timeout.

Copy the generated settings into the corresponding Railway service. Counter's
signer is private server configuration. Never commit an environment file.
Include the matching hash-named public token artifacts in the release; the first
token/pool creation needs their bytes. The checked-in artifacts match
[`devnet.json`](devnet.json). A future contract release must update these together.
Railway app builds do not deploy contracts or require the Rust toolchain.

## Verification

After [local setup](../../README.md#run-all-four-apps-locally), install Caddy 2.11
and Chromium, then run from the repository root:

```sh
npm run typecheck
npm test
CADDY_BINARY=/path/to/caddy npm run test:hosted
```

`test:hosted` builds all five apps with subpaths, starts their production servers
and Caddy, and checks direct links, reloads, assets, public config, and mobile/desktop
layouts in both themes. It uses the existing `.env.local` deployments and submits
no transactions. It requires Linux for process cleanup. It leaves subpath bundles
in `dist`; rebuild without `APP_BASE_PATH` before using standalone production servers.

## Custom domain

Attach `examples.thruput.network` to the gateway on port 8080 and add the DNS records
Railway supplies. After DNS and TLS are ready, update Launchpad's `VITE_SWAP_APP_URL`
to `https://examples.thruput.network/swap/` and restart Launchpad. The app base paths
do not change. Keep the Railway domain available until the custom domain works.

## Release and wallet checks

The current contracts use devnet network ID
`DFizVugYrvktaiKivvCx2P1ApArLuyYmH6vN3HN7FcNT` and wire format `14.1.1`.
The earlier network was reset. Use the addresses in `devnet.json`, not addresses
from before the reset. Starting or redeploying a web service reuses these contracts.

1. Confirm all five app services have a successful deployment. A web-service
   redeploy reuses its configured contracts; it does not deploy new contracts.
2. Open the public site. Each app's `/api/config` must show the network ID above;
   Counter and Airdrop use `networkId`; the other apps use `VITE_THRUPUT_NETWORK_ID`.
3. In Thruput Freighter, select `https://rpc.thruput.network`. Refresh or recreate
   a saved network entry if it still has the old network ID. Request devnet test
   tokens for your account.
4. **Counter:** press Increment once. Check that the transaction is confirmed and
   the chain value increases. Reload and check that the new value remains.
5. **Launchpad:** connect Freighter and create a token. Check the confirmed address,
   balance, and token directory entry. Use its Create pool link to open Swap.
6. **Swap:** select two tokens you own, create a pool, and add liquidity. Finish any
   processing step shown by the app. Make a small swap and check the output balance.
   The seven demo tokens and six pools seeded by Airdrop setup are available for
   wallet testing.
7. **Voting:** create a draft, open it, submit an answer, and check the tally.
   Close the poll and reload its direct URL to check the final results.
8. If a wallet action times out, inspect its saved transaction hash with the app's
   recovery controls before submitting anything else.

After the October 27 reset, all five app deployments passed their health checks
and loaded in a browser. Launchpad showed seven demo tokens, and Swap showed six
funded pools. Airdrop setup verified funding for 1,000 claims. The steps above
check wallet transactions separately.
