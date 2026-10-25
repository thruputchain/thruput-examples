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
Private npm packages require a build credential with `read:packages` access.
Keep the token in Railway variables, never in the repository.

The gateway uses `apps/gateway/Dockerfile`, `PORT=8080`, and `/healthz`.
`COUNTER_UPSTREAM`, `LAUNCHPAD_UPSTREAM`, `SWAP_UPSTREAM`, and `VOTING_UPSTREAM`
can override its upstream addresses. Watch each app's directory plus the root
`package.json`, `package-lock.json`, `.npmrc`, and `railpack.json` for deployments.

Until the hosting PR is merged, Voting and Examples Gateway follow
`feat/devnet-examples-hosting`. After merging, change those two source branches
to `main`. The three existing services already follow `main`.

The existing `railway.json` files describe the service settings for older Railway
workflows. Railway now rejects newly assigning a config-file path through its API;
configure the build/start/health settings directly in the service settings.

Keep one replica for Counter's in-memory faucet cooldown and each SQLite indexer.
Launchpad and Swap retain their `/data` volumes. Use a new factory-specific database
filename for each new deployment, so the previous registry remains intact.
Voting and the gateway need no volume.

Set Swap's token discovery variables to Launchpad's network, factory address,
and token code hash. In Railway, set
`TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://token-launchpad.railway.internal:3000`.
Set Launchpad's `VITE_SWAP_APP_URL` to the public URL ending in `/swap/`.
The internal discovery URL stays the same when the public domain changes.

## Contract releases

Build contracts and generated bindings together with the selected CLI:

```sh
export THRUPUT_CLI="$(command -v thruput)"
npm run generate:contracts --workspaces
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

`test:hosted` builds all four apps with subpaths, starts their production servers
and Caddy, and checks direct links, reloads, assets, public config, and mobile/desktop
layouts in both themes. It uses the existing `.env.local` deployments and submits
no transactions. It requires Linux for process cleanup. It leaves subpath bundles
in `dist`; rebuild without `APP_BASE_PATH` before using standalone production servers.

## Custom domain

Attach `examples.thruput.network` to the gateway on port 8080 and add the DNS records
Railway supplies. After DNS and TLS are ready, update Launchpad's `VITE_SWAP_APP_URL`
to `https://examples.thruput.network/swap/` and restart Launchpad. The app base paths
do not change. Keep the Railway domain available until the custom domain works.
