# Token Launchpad

Create tokens through [Thruput Freighter](https://www.thruput.network/docs/tools/wallet-extension/)
and browse factory launches. A registry indexes discovery events; balances and
transaction verification use live chain reads. The app never receives wallet keys.
For individual SDK operations, start with [client examples](../../examples/typescript/README.md).

## Local setup

Complete [root setup](../../README.md#setup), including `npm ci`, and start
`thruput node --port 9545 --json` in another terminal. Then:

```sh
npm run setup:local --workspace apps/token-launchpad
npm run dev --workspace apps/token-launchpad
```

Open **http://127.0.0.1:5173**. The dev server includes the registry and indexer.
Configure Freighter for the same local endpoint and request test native tokens to sign
transactions. Setup creates an empty factory, not demo tokens.

Every setup run builds contracts/bindings, deploys fresh infrastructure, and
writes `.env.local` plus immutable hash-named public artifacts. Failed setup
keeps the old environment. Setup saves its deployer key and transaction outcomes
under `.local/launchpad-setup/run-*`, beside the environment output. The key file
is private; app configuration contains only public values. Restart the app after
setup. Existing deployments need their matching artifacts and bindings.

Setup funds the deployer and native-token storage reserve, then funds, deploys,
and initializes the factory in one atomic transaction. It verifies the factory
configuration at the confirmed block height before publishing the environment.
An uncertain transaction remains recorded as unknown and is never retried.

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

- `THRUPUT_RPC_URL`: endpoint override; defaults to `http://127.0.0.1:9545`
  locally and `https://rpc.thruput.network` for Devnet.
- `THRUPUT_NETWORK_ID`: optional expected network hash (base58).
- `THRUPUT_RUNTIME_MANIFEST`: optional manifest used to check network identity.
- `THRUPUT_CLI`: optional CLI executable; defaults to `thruput` on `PATH`.
- `LAUNCHPAD_APP_ENV`: environment output path.
- `LAUNCHPAD_ARTIFACT_ROOT`: compiled contract directory.
- `LAUNCHPAD_APP_PUBLIC_DIR`: public artifact output directory.

Paths resolve from the repo root. Both modes discover network identity through
the SDK and read storage costs with `getChainConfig()`. Setup checks the app's
native balance charge and token initialization budget before funding.
The registry defaults to factory-scoped SQLite under `.local/`;
`TOKEN_REGISTRY_DB_PATH` overrides it. Use one writer per database.

Run `npm run setup:devnet --workspace apps/token-launchpad` for Devnet defaults.
It creates a fresh deployment and writes `.env.devnet`. Both setup commands use
the same steps. Local token funding is 1,000,000 raw units; Devnet uses 10,000,000.
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
- `scripts/index.ts`: setup inputs and named deployment steps for both networks.
- `scripts/run.ts`: persona keys and confirmed, failed, or unknown outcomes.
- `scripts/setup.test.ts`: setup and publication tests.
- `tests/e2e/token-launchpad.ts` (repository root): isolated live acceptance checks.

Wallet execution uses published SDK methods; the app retains hashes and
workflow state across uncertain outcomes. Disconnecting does not erase evidence
or grant permission to resubmit. Public reads remain available without a wallet.

Run `typecheck`, `test`, or `build` with `--workspace apps/token-launchpad`.
After generating contracts, run `npm run test:token-launchpad` from the root.
It starts an isolated nonzero-network node, tests both setup modes, and creates a
token from each factory using the published artifact and exact prefunding amount.
It also checks network mismatch rejection and preservation of existing output.
Configuration and private fixture state stay in the printed temporary directory.
Set `THRUPUT_CLI` and `THRUPUT_DEVNODE_BINARY` to select compatible binaries.
Root browser, seeding, and batching checks are listed in the
[script guide](../../scripts/README.md#checks).
