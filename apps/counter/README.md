# Thruput Counter

A shared counter with increment/decrement buttons and a keyboard transaction
area. Each captured keydown sends a random +1 or −1 transaction. Holding a key
repeats; Escape stops capture. The server signs with a funded development key
that stays on the server.

## Local setup

Use Node.js 22.13 or newer and run `npm ci` from the repository root with the
[npm registry authentication](../../README.md#install-swap-and-launchpad-dependencies)
configured.

Use the matching releases **groundhog-rpc `v0.16.0-rc.1`** (commit `7c2588a`)
and **hog-devnode `v0.1.27-rc.4`**. This pair is verified for contract builds,
setup, concurrent transactions, and browser submission. Check out the exact RPC
release tag when building the CLI: later commits on `main` can report the same
version while requiring a newer devnode runtime manifest.

Start the compatible node in a separate terminal:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_DEVNODE_BINARY=/absolute/path/to/hog-devnode
"$GROUNDHOG_CLI" node --port 9545 --dev-account-count 0 \
  --hog-devnode-binary "$GROUNDHOG_DEVNODE_BINARY" --json
```

Use the runtime-manifest path printed by that node:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/counter
npm run dev --workspace apps/counter
```

Open **http://127.0.0.1:5175**. Setup generates bindings, funds a new development
account and the counter's storage, deploys the contract, initializes it to
**1,000,000**, and writes `.env.local`. Every setup run creates a fresh counter
and signer. This also handles a fresh node or an old public-key configuration.
Restart the app server after setup. If setup fails, the previous environment
file is kept.

Setup overrides:

Relative paths are resolved from the repository root.

- `GROUNDHOG_RPC_URL`: loopback HTTP endpoint, default `http://127.0.0.1:9545`.
- `COUNTER_APP_ENV`: output path, default `apps/counter/.env.local`.
- `COUNTER_ARTIFACT`: compiled artifact path, default `target/groundhog/counter.rv32a`.

## Devnet

Recorded deployment on the hosted network:

| Field | Value |
| --- | --- |
| RPC | `https://rpc.thruput.network` |
| Network ID | `0xabccfe796b3065d9f9985be6db9e2d01880f29d990447d9ea596a97009e73642` |
| Counter address | `0xbc42026c29190b21cc6991770a0e70b9e035671d53d185beb224ff51c8c61ed6` |
| Signer address (public) | `0x08fff37518ff08ad362bc9a2f25ab91ca52849d3d1fa1c767ff043e1d6127038` |
| Deploy transaction | `0xc4944d41c526bd45fda9e1da78ce5f986fece41c22a92254a24f0eb092cb38fd` |
| Initial value | `1,000,000` |

Both setup commands build the counter and regenerate bindings before running
their TypeScript setup script. To create a fresh Devnet demo:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RPC_URL=https://rpc.thruput.network
export GROUNDHOG_NETWORK_ID=0xabccfe796b3065d9f9985be6db9e2d01880f29d990447d9ea596a97009e73642
npm run setup:devnet --workspace apps/counter
```

Setup writes the new address and signer to `.env.devnet`. Each run creates a
new deployment; it does not resume or modify the recorded counter above. To
host that existing counter, use the `.env.devnet` already saved for it.
Devnet can be reset; verify the live network identity before reusing an address.

## Environment files

Counter needs only `.env.local` for the local node and `.env.devnet` for hosted
Devnet. Both are ignored by Git and contain the private server signer. Copy the
Devnet values into the hosting service's variables when deploying the app.
`COUNTER_APP_ENV` can override the output path for either setup command.

There is no `.local/` directory, deployment journal, or recovery workflow for
Counter. Its public deployment addresses are recorded above. Keep the environment
file while using that deployment; run setup again when you want a fresh demo.

## Behavior

- **Top up Signer** in the header shows the live signer balance and requests a test-HOG airdrop for the configured
  signer. The server allows one attempt every 10 minutes, including failed
  attempts. The faucet also applies its own cooldown or quota. The
  loading, success, and error states appear as Sonner toasts. The button shows
  up to three decimal places; hover for the exact balance. Airdrops do not count
  toward the counter's session statistics.
- One configured counter is shared by all visitors. The large number comes from
  chain reads. Input feedback does not claim that a transaction has committed.
- Session statistics count this browser's work only. Confirmed tx/s is successful
  receipts observed during the last five seconds divided by five, not network
  throughput. Pending includes queued inputs; unknown results are shown separately.
- One Web Worker requests signed transactions and submits up to 16 operations
  concurrently. Receipt checks have a separate pool of 16. Confirmation does
  not block the next submission. The server allows up to 64 active preparations.
- At most 512 operations remain outstanding. When full, the app stops accepting
  inputs until space is available. Inputs rejected during a burst are counted.
- Receipt checks retry by the original hash. A lost send response or timeout is
  unknown, not a failed transaction or permission to send another one.
- The counter cannot go below zero. Manual decrement is disabled at zero; a
  random decrement can fail at the lower bound. The initial value gives the
  demo room for random updates.
- Session state is in memory. Reloading starts new session counts; committed
  transactions and the shared counter persist on the node. Reload does not
  cancel transactions already sent.

## Commands

Run `npm run <command> --workspace apps/counter`:

| Command | Purpose |
| --- | --- |
| `dev` | Vite UI, runtime configuration, and RPC proxy |
| `build` | Typecheck and production build |
| `start` | Serve the production build, configuration, and RPC proxy |
| `setup:local` | Build and provision a local demo |
| `setup:devnet` | Build and provision a counter on a pinned Devnet network |
| `generate:contracts` | Build the counter and regenerate its bindings |
| `typecheck` | Browser, server, and setup TypeScript checks |
| `test` | Transaction scheduling, keyboard controls, configuration, and HTTP tests |

## Deployment

Set the values in [`.env.example`](.env.example), then run `build` and `start`.
`PORT` defaults to 3000. Railway builds from the root npm workspace.
The existing `railway.json` is for legacy
Railway services. No database is needed.

The server returns public runtime configuration at `/api/config`: network ID,
counter address, signer address, and optional explorer URL. The
`COUNTER_SIGNING_PRIVATE_KEY` value stays on the server. The same endpoint is
used in development and production, so configuration changes need a server
restart and page reload, not a rebuild. `VITE_EXPLORER_URL` is an optional
HTTP(S) origin.

`POST /api/prepare` accepts only `{"direction":"increment"}` or
`{"direction":"decrement"}`. The server fixes the counter address, amount of
one, wallet wrapper, gas limits, network, and expiry. It returns the signed
transaction without submitting it. The browser computes the transaction hash
before submission, so a lost send response can still be checked by hash.

`POST /api/topup` accepts only `{}` and calls the client SDK's `requestAirdrop`
over RPC for the configured signer. It never accepts a caller-selected recipient
or amount. A process-wide cooldown rejects further requests with HTTP 429 and
`Retry-After` before RPC work begins, even if the previous attempt failed.
Cross-origin browser requests are rejected. The cooldown is in memory and
resets on restart; use one replica for this demo. The faucet remains responsible
for network-wide limits.

`/groundhog-rpc` forwards counter reads, account balance, receipt/status checks,
and signed-transaction submissions to the configured upstream. Before forwarding
a submission, it checks the wallet root, authorization claim, counter target,
entrypoint, amount, and gas limits against the two allowed calls. Multiple calls
and attached contract code are rejected. The raw proxy does not retry submissions
or forward arbitrary airdrop requests. `/healthz` checks server configuration readiness;
the browser separately checks the network, counter, and development balance.

## Live and browser checks

After building the counter artifact and app:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_DEVNODE_BINARY=/absolute/path/to/hog-devnode
npm run build --workspace apps/counter
npm run test:counter
```

This Linux test owns an isolated node and uses temporary app configuration. It
checks fresh deployments on setup reruns, a 120-transaction mixed
burst through the signing API with an exact final value,
and 42 real browser transactions through the production server and Web Worker.
It checks held keys, Escape, button keyboard activation, reconnect behavior, and
mobile overflow, then confirms a transaction through the Vite development server.
It saves desktop/mobile screenshots in the printed temporary directory.
Set `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`.

## Code map

- `src/app.tsx`, `src/components/`, `src/styles.css`: screen and Thruput theme.
- `src/transactions/`: bounded engine, worker, and React lifecycle.
- `src/groundhog/client.ts`: signing requests, submission, reads, and receipt observation.
- `src/contracts/generated/`: generated ABI; do not edit by hand.
- `server/`: private signing, submission policy, runtime configuration, RPC forwarding, and production static server.
- `scripts/`: contract generation, network-specific setup entrypoints, and shared Counter provisioning.
