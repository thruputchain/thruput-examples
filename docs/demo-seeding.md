# Local demo seeding

Run these commands from the repository root against a compatible local Groundhog
node. Both apps and the sibling TypeScript SDK must be installed and built.
`GROUNDHOG_CLI`, `GROUNDHOG_RPC_URL`, and `GROUNDHOG_RUNTIME_MANIFEST` have the
same meaning as in the setup instructions.

```sh
npm --prefix apps/swap run setup:local
npm --prefix apps/token-launchpad run setup:local
# Start the launchpad registry for this setup (see below).
npm --prefix apps/token-launchpad run seed:tokens
npm --prefix apps/swap run seed:pools
```

Setup remains infrastructure-only. Seeding is a separate, repeatable operation:

1. `seed:tokens` creates **gUSD** and **gEUR** through the real launchpad factory's
   CREATE2 flow. Each has six decimals and an initial supply of 1,000,000.
2. The command requests a registry sync and waits for canonical `TokenCreated`
   evidence in the launchpad datastore. It never inserts database rows itself.
3. `seed:pools` resolves the recorded addresses through the launchpad HTTP API,
   checks their factory, creator, creation transaction, metadata, and supply,
   then validates the live tokens. It creates one pool, supplies **1,000 gUSD +
   1,000 gEUR**, processes the liquidity request, and verifies its mint event,
   live reserves, and recipient LP balance.

The seed commands attach the immutable token and LP code artifacts published by
setup. They read live factory funding requirements and fund token storage for
the additional holder and allowance rows needed by the demo.

Before either seed command writes to the ledger, it checks both sides of the
swap factory/router relationship. The current ABI has no relationship getter
or initialization event, so the tool uses the SDK's committed `getStorageAt`
RPC: `Factory.router` (slot 2) must name the router, and `Router.cfg.factory`
(slot 0, a single-address configuration) must name the factory. The storage
keys follow the pinned SDK 0.30 CXS-framed domain/slot layout. Missing, changed,
or unsupported layouts and RPC failures stop seeding; a successful
`poolFunding` view alone is not sufficient. This check requires no contract or
setup changes.

## Registry prerequisite

The launchpad registry must be running before either seed command. A Vite dev
server alone is insufficient. Seeding checks the HTTP service's network and
factory before submitting transactions; an unavailable or mismatched registry
stops the command.

After both setup commands, run the following in a separate terminal **from
`apps/token-launchpad`**:

```sh
export VITE_TOKEN_REGISTRY_ENABLED=true
export PORT=3001
export TOKEN_REGISTRY_DB_PATH=../../.local/token-registry.sqlite
npm run build:production
node --env-file=.env.local --import tsx server/main.ts
```

Use a fresh database path when setup creates a new factory. The production
server checks that its build, runtime configuration, and database scope agree.
An existing matching registry can be reused. Set `LAUNCHPAD_REGISTRY_URL` for
the seed commands if its origin differs from `http://127.0.0.1:3001`.

The exact-address endpoint is:

```text
GET /api/tokens?tokenAddress=0x<64 hex digits>
```

It applies an exact token-address filter within the registry's network/factory
scope. Seeding does not use symbol search or read SQLite directly. Swap's own
registry can discover the resulting pool through its normal canonical indexer;
see [cross-app operations](cross-app-operations.md) for browser-service setup.

## Ownership

By default, a generated **tool-only seed account** administers both tokens,
holds their supply, supplies liquidity, and receives the LP tokens. It is
independent of browser wallets and setup deployers.

To give your extension account the token administration, remaining supply, and
LP tokens, set its **public address** before the first token seed:

```sh
export SEED_RECIPIENT=0x<your extension account address>
npm --prefix apps/token-launchpad run seed:tokens
npm --prefix apps/swap run seed:pools
```

The seed signer initially holds all minted tokens so it can fund the pool.
After liquidity succeeds, it transfers **999,000 of each token** to the
recipient; LP tokens are minted directly to that recipient. Until `seed:pools`
finishes, the remaining supply stays with the tool account. No extension key,
browser persona, or wallet approval is needed. The recipient is recorded and
cannot be changed on a rerun; subsequent commands can omit `SEED_RECIPIENT`.

## State and recovery

The default state directory is `.local/seed/<scope-digest>/`. The digest binds
the network, both factories, router, and code hashes. Each directory contains:

- `manifest.json`: public account/recipient and token/pool addresses, CREATE2
  nonces, transaction intents, original hashes, and signed transaction bytes.
- `signer.key`: a separate raw 32-byte seed, created with mode **0600**. It is
  local plaintext tooling state, not an encrypted wallet export. Never copy it
  into app configuration or a browser.
- `lock/`: prevents concurrent seed commands from using the same state.

`.local/` is gitignored. Keep the signer and manifest together. The commands do
not print the private seed or raw RPC errors, and they load only allowlisted
public fields from setup's environment files.

Every signed transaction's canonical hash and bytes are durably saved **before
submission**. Before creating the signer or manifest, the command creates and
syncs the directory ancestry, including each parent entry and existing
directories left by interrupted runs. A failed directory sync stops the run.
Reruns read a transaction's receipt/status rather than generating a new nonce.
An unexpired unknown transaction may be resubmitted with identical bytes.
Pending transactions remain pending; expired unknown transactions block rather
than risk duplicate execution. Successful transactions are never repeated.

If a transaction has an authoritative invalid status or a committed failure,
fix the cause and set `SEED_RETRY_FAILED=1` to permit a replacement attempt.
The original attempt remains in the manifest. This flag cannot replace an
expired transaction whose outcome is unknown.

Liquidity request completion is recorded separately from crank transaction
success. The manifest binds terminal evidence to the original request ID, queue
transaction, and receipt block. Canonical event scans retain that block anchor
across pagination and include both `MintEvent` and `RequestFailed`. An incomplete
or lagging scan stops the run before another crank. The command can submit up
to four new numbered `process-liquidity-N` transactions per invocation, observing
results between them. If the request is still pending, rerun to continue with
new numbers; committed crank steps are read back, never submitted again. The
older single `process-liquidity` step is also recoverable. A correlated failure
is persisted and reported explicitly, and stops further cranking or enqueueing.
Completed terminal evidence is rechecked against its receipt on reruns.

After a hard process termination, a `lock/` directory may remain. Confirm that
no seed process is running before removing that empty directory, then rerun the
same command. Preserve the manifest and signer. Deleting seed state on a live
ledger starts a different demo run and can create additional tokens.

Supported path overrides:

| Variable                   | Default                           |
| -------------------------- | --------------------------------- |
| `SEED_STATE_DIR`           | Repository `.local/seed`          |
| `LAUNCHPAD_APP_ENV`        | `apps/token-launchpad/.env.local` |
| `SWAP_APP_ENV`             | `apps/swap/.env.local`            |
| `LAUNCHPAD_APP_PUBLIC_DIR` | `apps/token-launchpad/public`     |
| `SWAP_APP_PUBLIC_DIR`      | `apps/swap/public`                |
| `GROUNDHOG_RPC_URL`        | Launchpad setup's public RPC URL  |
| `LAUNCHPAD_REGISTRY_URL`   | `http://127.0.0.1:3001`           |

RPC and registry URLs must use loopback HTTP. Both app configurations must name
the same network. Both HTTP paths reject redirects, including RPC redirects
that would otherwise forward signed transaction bodies to another endpoint.
Rerun seeding against the original infrastructure; rerunning
setup creates new infrastructure and therefore a different seed scope.

## Verification

```sh
npm --prefix apps/token-launchpad test
npm --prefix apps/token-launchpad run typecheck
npm --prefix apps/swap run typecheck
GROUNDHOG_CLI=/absolute/path/to/compatible/groundhog \
  npm --prefix apps/token-launchpad run test:seed:local
```

The live test starts its own node on an ephemeral port, provisions isolated
infrastructure and artifacts, and runs the real canonical indexer and HTTP
server against a temporary database. It verifies recipient balances, LP tokens,
exact reserves, two indexed tokens, one pool, and unchanged transaction evidence
on rerun. It checks that the user's app environment files remain unchanged.
Evidence is kept under `/tmp/opencode/demo-seed-*`.

Optional test overrides are `GROUNDHOG_DEVNODE_BINARY`,
`SEED_TEST_ARTIFACT_ROOT`, `SEED_TEST_DEFAULT_OWNER=1` to exercise default tool-account
ownership, and `GROUNDHOG_E2E_HOGD_PROTOCOL` for an explicitly
compatible local protocol build. Unit tests cover persistence failure, lost
submission responses, pending/unknown recovery, canonical hash checks, scope
mismatch, and explicit retries that retain original hashes.

Review regression tests also cover parent-directory sync failures, a real local
307 redirect that receives no forwarded payload, both factory/router mismatch
directions, zero-result/partial cranks followed by a later mint, bounded crank
continuation across restarts, and terminal failures. Live acceptance additionally
mixes a factory with another initialized router and verifies rejection before
any seed state or ledger write.
