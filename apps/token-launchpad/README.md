# Token Launchpad

Create tokens through [Thruput Freighter](https://github.com/thruputchain/freighter)
and browse factory launches. A registry indexes discovery events; balances and
transaction verification use live chain reads. The app never receives wallet keys.
For individual SDK operations, start with [client examples](../../examples/typescript/README.md).

## Local setup

Complete [root setup](../../README.md#setup), including `npm ci`, and start
`thruput node --port 9545 --json` in another terminal. Then:

```sh
export THRUPUT_CLI="$(command -v thruput)"
export THRUPUT_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/token-launchpad
npm run dev --workspace apps/token-launchpad
```

Open **http://127.0.0.1:5173**. The dev server includes the registry and indexer.
Configure Freighter for the same local endpoint and request test native tokens to sign
transactions. Setup creates an empty factory, not demo tokens.

Every setup run builds contracts/bindings, deploys fresh infrastructure, and
writes `.env.local` plus immutable hash-named public artifacts. Failed setup
keeps the old environment. The deployer key is not saved. Restart the app after
setup. Existing deployments need their matching artifacts and bindings.

## Demo tokens

App servers do not need to run for seeding:

```sh
export SEED_RECIPIENT=<your-base58-wallet-address>
npm run seed --workspace apps/token-launchpad
```

Each invocation creates new gUSD and gEUR tokens with six decimals and
1,000,000 units each. The recipient owns the supply and is administrator.
There is no saved signer or resume state. A failed run stops and prints known
transaction hashes; another run creates different assets. See
[fresh seeding](../../scripts/seed/README.md) for failure behavior.

To create a pool, use [Swap seeding](../swap/README.md#demo-pool), which creates
its own token pair and supplies liquidity in one run.

## Configuration and deployment

See [`.env.example`](.env.example) for settings. Setup overrides:

- `THRUPUT_RPC_URL`: loopback HTTP endpoint for local setup.
- `LAUNCHPAD_APP_ENV`: environment output path.
- `LAUNCHPAD_ARTIFACT_ROOT`: compiled contract directory.
- `LAUNCHPAD_APP_PUBLIC_DIR`: public artifact output directory.

Paths resolve from the repo root. Local setup reads storage costs from the
runtime manifest. The registry defaults to factory-scoped SQLite under `.local/`;
`TOKEN_REGISTRY_DB_PATH` overrides it. Use one writer per database.

For `setup:devnet`, supply an HTTPS `THRUPUT_RPC_URL` and verified live
`THRUPUT_NETWORK_ID` (unprefixed base58). It creates a fresh deployment and
writes `.env.devnet`.
Use `dev -- --mode devnet` to select it locally. For hosting, supply environment
values to `start` (`PORT` defaults to 3000). Railway uses
`apps/token-launchpad/railway.json` and the root npm install.

Public settings load from `/api/config`, so changes need a restart/reload rather
than a rebuilt bundle. The RPC proxy is read-only; wallet writes go through the
provider. `VITE_SWAP_APP_URL` enables the Swap handoff. Configure explorer and
network settings as described in `.env.example`.

## Code and checks

- `src/main.tsx`, `app.tsx`, `app-providers.tsx`: startup, SDK/React providers, routing.
- `src/launch/`: review, execution, and saved workflow recovery.
- `src/transactions/`: SDK wallet calls and receipt observation.
- `src/contracts/`: typed calls and generated bindings; regenerate, do not edit generated files.
- `server/`: registry, SQLite, indexer, HTTP server; `shared/`: browser/server models.
- `scripts/`: generation and network-specific provisioning.

Wallet execution uses published SDK methods; the app retains hashes and
workflow state across uncertain outcomes. Disconnecting does not erase evidence
or grant permission to resubmit. Public reads remain available without a wallet.

Run `typecheck`, `test`, or `build` with `--workspace apps/token-launchpad`.
Root browser, seeding, and batching checks are listed in the
[script guide](../../scripts/README.md#checks).
