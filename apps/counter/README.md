# Counter app

A counter with development signing for concurrent button and keyboard updates.
No wallet connection or approval prompts are needed. Holding a key repeats;
Escape stops capture.
For the smaller contract example, start with
[Counter](../../contracts/counter/README.md).

## Local setup

Complete [root setup](../../README.md#setup) and `npm ci`. In a separate terminal:

```sh
thruput node --port 9545 --json
```

Use the printed runtime manifest in the setup terminal:

```sh
export THRUPUT_CLI="$(command -v thruput)"
export THRUPUT_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
npm run setup:local --workspace apps/counter
npm run dev --workspace apps/counter
```

Open **http://127.0.0.1:5175**. Every setup run builds the contract/bindings,
creates a fresh signer, funds/deploys Counter, initializes it to 1,000,000,
and writes `.env.local`. Failed setup keeps the previous file. Restart the app
after setup. The server keeps the private development signer; browsers receive
only public configuration and signatures for the two allowed counter calls.

Overrides: `THRUPUT_RPC_URL` (loopback HTTP, default port 9545), `COUNTER_APP_ENV`
(environment output), and `COUNTER_ARTIFACT` (compiled artifact). Paths resolve
from the repo root.

## Behavior

- All updates use the server's development signer. Configure
  `COUNTER_SIGNING_PRIVATE_KEY` through setup to enable updates.
- A Web Worker has separate bounded submission and receipt-observation queues.
  Confirmation does not block the next submission; full queues stop new inputs.
- Pending and unknown outcomes remain distinct. A timeout is not permission to
  resubmit a transaction; observation uses its original hash.
- Session statistics measure this browser's confirmed work, not network throughput.
  Reload clears statistics but does not cancel transactions already sent.
- **Top up Signer** requests test native tokens. The server applies a 10-minute in-memory
  cooldown, and the faucet has its own limits. Use one server replica for this demo.

## Commands and deployment

Run `npm run <command> --workspace apps/counter`:

| Command | Purpose |
| --- | --- |
| `dev` | Vite UI and signing/RPC server |
| `generate:contracts` | Build Counter and regenerate its binding |
| `setup:local`, `setup:devnet` | Create a fresh deployment and environment |
| `typecheck`, `test`, `build` | Check types, tests, and production bundle |
| `start` | Serve the production bundle; `PORT` defaults to 3000 |

For Devnet, set `THRUPUT_RPC_URL` to the HTTPS endpoint and
`THRUPUT_NETWORK_ID` to its verified live base58 network hash, then run
`setup:devnet`.
It writes `.env.devnet`; select it with `dev -- --mode devnet` or supply its
values to the production server. Environment files contain private signer
material and are ignored by Git. See [`.env.example`](.env.example).

Railway uses `apps/counter/railway.json` and the root npm workspace. No database
is required. Public config arrives at `/api/config`; configuration changes need
a server restart and page reload, not a bundle rebuild. `/api/prepare` restricts
signatures to counter increments/decrements; `/thruput-rpc` validates submissions
against that policy. `/healthz` checks server configuration readiness.

## Code and checks

- `src/app.tsx`: UI; `src/transactions/`: scheduler, worker, and React lifecycle.
- `src/thruput/client.ts`: SDK calls; `src/contracts/generated/`: generated binding.
- `server/`: private signing, transaction policy, and HTTP endpoints.
- `scripts/`: build, generation, and provisioning.

Root `npm run test:counter` checks an isolated node and real browser input after
the artifact and app are built. See
[checks and prerequisites](../../scripts/README.md#checks).
