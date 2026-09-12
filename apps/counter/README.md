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
**1,000,000**, and writes `.env.local`. Rerunning setup verifies the existing
deployment without adding to its value. On a new node, select a fresh
`COUNTER_APP_ENV` path or move the old environment file before setup.

### Upgrade a previously public signer

If `.env.local` contains `COUNTER_DEVELOPMENT_PRIVATE_KEY`, stop the app server
and rerun `setup:local` against the same node. Setup generates and funds a fresh
server-only signer, writes `COUNTER_SIGNING_PRIVATE_KEY`, and removes the old
key entry. It preserves the counter address, value, and other configuration.
Then restart the app server and reload the page. Do not copy the old exposed key
into the new variable. The server refuses the old configuration until it is
migrated.

Setup overrides:

- `GROUNDHOG_RPC_URL`: loopback HTTP endpoint, default `http://127.0.0.1:9545`.
- `COUNTER_APP_ENV`: output path, default `apps/counter/.env.local`.
- `COUNTER_ARTIFACT`: compiled artifact path, default `target/groundhog/counter.rv32a`.

## Behavior

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
| `setup:devnet` | Deploy the built counter to a pinned Devnet network and save Railway variables |
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

`/groundhog-rpc` forwards counter reads, account balance, receipt/status checks,
and signed-transaction submissions to the configured upstream. Before forwarding
a submission, it checks the wallet root, authorization claim, counter target,
entrypoint, amount, and gas limits against the two allowed calls. Multiple calls
and attached contract code are rejected. It does not retry submissions or expose
airdrops. `/healthz` checks server configuration readiness;
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
checks setup reruns, migration of the exposed signer, a 120-transaction mixed
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
- `scripts/`: contract generation and local provisioning.
