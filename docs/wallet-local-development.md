# Wallet app development

Swap and Token Launchpad use the same npm workspace, commands, wallet boundary,
and registry-based directory pattern. The extension remains a separate app.

## Install

Use Node 22.13 or newer. The sibling `groundhog-client-ts` must contain the
provider API and built `/provider` and `/wallet` exports. From this repository:

```sh
npm --prefix ../groundhog-client-ts ci
npm --prefix ../groundhog-client-ts run build
npm ci
npm --prefix apps/wallet-extension ci
npm --prefix apps/wallet-extension run build
```

The two example apps share the root lockfile. The root npm setting works around
an npm 10 optional-peer resolution error with the linked development SDK.

## Provision and run

Start a compatible local node at `http://127.0.0.1:9545`. Keep its full runtime
manifest. Setup uses temporary tooling keys, never browser keys, and creates
only the factories, router, and required implementation code.

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/swap
npm run setup:local --workspace apps/token-launchpad
```

Run each in its own terminal:

```sh
npm run dev --workspace apps/token-launchpad
npm run dev --workspace apps/swap
```

Launchpad uses port **5173**, Swap **5174**, both with strict ports. Each dev
server also runs its registry API and indexer. No additional registry service
or registry-enabled flags are needed. Default SQLite files live under each
app's `.local/`, scoped by factory address. Override `TOKEN_REGISTRY_DB_PATH` or
`POOL_REGISTRY_DB_PATH` when needed; never run two writers on the same file.

To enable cross-app links and search, add these after setup:

| App | Setting |
| --- | --- |
| Launchpad | `VITE_SWAP_APP_URL=http://127.0.0.1:5174` |
| Swap | `VITE_TOKEN_DISCOVERY_ENABLED=true` |
| Swap | `TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://127.0.0.1:5173` |
| Swap | Copy Launchpad's `VITE_STANDARD_TOKEN_FACTORY_ADDRESS` and `VITE_STANDARD_TOKEN_HASH` |
| Either | Optional `VITE_EXPLORER_URL` for the same network |

Restart the dev servers after changing environment files. Setup generates
immutable hash-named code artifacts; keep them with the matching configuration.

## Use the apps

1. Load `apps/wallet-extension/dist` at `chrome://extensions` using **Load unpacked**.
2. Create or import a test wallet, select Localnet, and request HOG.
3. Connect to Launchpad and create two tokens, or use [demo seeding](demo-seeding.md).
4. Connect to Swap and create a pool using those token addresses.
5. Approve required queue-processing transactions. An enqueue receipt alone does
   not prove that liquidity or a swap executed; check its terminal result.

The wallet keeps keys and submits transactions. Apps use read-only RPC proxies
for reads and recovery. Unknown outcomes retain their original hashes; do not
send replacements just because a response timed out.

ERC20 contracts may need additional HOG storage reserve for new holders. If
required, explicitly send HOG to the token contract address. No hidden top-up or
automatic replacement transfer is performed.

## Verify

```sh
npm run typecheck
npm test
npm run test:browser
```

The browser check uses fixture APIs and cannot sign. Live isolated checks need
compatible CLI/devnode binaries and already-built contracts:

```sh
npm run test:wallet
npm run test:seed
```

Both protect existing app environments and use separate node state. See
[wallet acceptance](wallet-acceptance.md) for runtime compatibility and historical
evidence. The CLI and devnode must agree on the runtime-manifest schema; changing
only the advertised protocol token cannot fix a schema mismatch.

## Production

Run `npm run build --workspace apps/<app>`, then `npm run start --workspace
apps/<app>`. Set `PORT` and the app's database path. Startup loads `.env.local`
if present; process environment wins. The build validates public artifacts and
emits an exact public configuration manifest which startup verifies again.

Devnet wallet selection does not redeploy app infrastructure. The app's network,
factories, and artifacts must match the selected network. Local setup accepts
loopback RPC only. Use test funds; full simulation and external auditing remain
outside this prototype.
