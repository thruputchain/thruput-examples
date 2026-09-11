# Groundhog AMM

Browse Uniswap V2-style pools without a wallet. Connect the Groundhog wallet
extension to create pools, add/remove liquidity, swap, or process queues. This
applies to both Vite development and the production registry deployment.
The app never receives a private key and never submits transactions through its
public RPC proxy. The extension signs and submits; the app observes receipts.

## Install

Use Node.js 22.13 or newer and npm. Groundhog packages require GitHub Packages
access (`read:packages`); configure npm authentication outside this repository.

GH-251 intentionally tests the unpublished wallet-provider SDK using
`file:../../../groundhog-client-ts`. Check out the sibling repository at
`/home/chambaz/Work/groundhog-client-ts` on `feat/wallet-provider` and build it
before installing this app. A standalone deployment must include that sibling
at the same relative path, or replace this dependency with a published release
that exposes `/provider` and `/wallet` before building.

```sh
npm --prefix apps/swap ci
```

## Infrastructure Setup

Start a compatible Groundhog node separately. Setup requires the current CLI,
RPC wire format 4 or newer, and access to the Rust contract registry. It creates
infrastructure only: the native HOG reference, factory, router, handler/driver
code, and LP token artifact. It does not create user wallets, user tokens, pools,
or seeded liquidity. There is no Alice/Bob/Carol dropdown or browser key config.

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545
npm --prefix apps/swap run setup:local
npm --prefix apps/swap run dev
```

Setup writes `.env.local` with public infrastructure configuration and an empty
`VITE_KNOWN_TOKEN_ADDRESSES`. It also writes
`public/contract-artifacts/${hash}.json` with exactly `{contractType: "rv32", data, hash}`
and sets `VITE_POOL_TOKEN_HASH` to its contract hash. The filename includes the
hash's `0x` prefix. These immutable, generated artifacts
are ignored by Git. Setup is not idempotent; use a fresh disposable ledger after
a partial provisioning failure. Restart Vite after regenerating configuration.

## Wallet Connection

For tool-driven demo data after both apps' infrastructure setup, run launchpad's
`seed:tokens`, then `npm --prefix apps/swap run seed:pools` from the repository
root. See [local demo seeding](../../docs/demo-seeding.md) for the registry
prerequisite, optional extension-account recipient, and resumable state.

Install/build `apps/wallet-extension`, configure it for the same network, and
create/import an account there. Fund that account independently. Select its
provider in Swap, click **Connect wallet**, and approve the origin in the
extension. If multiple accounts are authorized, use the account selector.
The connected address is displayed with an optional explorer link.

Only public provider identity crosses this boundary: address, Ed25519 public
key, and derivation nonce. The configured network must match the session.
Disconnect immediately disables writes locally, disposes the adapter, and asks
the extension to revoke the session. Account/network/lock changes invalidate
the old adapter and remount routes, discarding stale quotes and forms. Stored
workflows remain scoped by network, factory/pool, and account.

Disconnected views use an explicit zero-address read-only caller because
contract views require a caller. It is not a wallet and is never displayed as
one. No `VITE_GROUNDHOG_WALLET_ADDRESS`, wallet entrypoint, or private key is
required. Creation, swap, and liquidity routes are gated by connection, not by
production mode. Keep one browser origin: `localhost` and `127.0.0.1` have
different extension permissions, local storage, and locks.

## Empty-Factory Creation

Create/fund two tokens independently, for example through the launchpad. Open
**Create Pool**, supply their addresses and initial amounts, review, and approve
each requested transaction in the extension.

The creation workflow reads the factory funding policy, approves three times
the recommended native HOG funding, then invokes `create_pair`. The runtime
only persists code when it is deployed, so the first `create_pair` must carry
the LP ERC-20 contract. Swap lazily fetches only the fixed same-origin
`/contract-artifacts/${VITE_POOL_TOKEN_HASH}.json` path for that exact factory method. It rejects
redirects, limits the body to 8 MiB and the request to 10 seconds, validates the
artifact, and checks `hashContract` against `VITE_POOL_TOKEN_HASH` before signing.
Missing or mismatched artifacts fail before signing. Ordinary approvals, swaps,
liquidity changes, and cranks never fetch or attach this artifact.

Vite copies the hash-named asset from its resolved `publicDir` into production
`dist`. Every production build validates the source and copied asset: it must
exist, use the exact three-field schema, and recompute to `VITE_POOL_TOKEN_HASH`.
Startup validates the served `dist` asset again before RPC access or database
creation. Neither step provisions or repairs artifacts. Missing/corrupt files
fail closed. Provision before building, and deploy matching immutable artifacts
and configuration together. Do not point the browser at arbitrary artifact URLs.

The factory creates and funds the LP token, handler, and driver atomically.
The handler owns reserves and emits successful liquidity/swap events; the
driver queues requests and emits failures. Initial token allowances are granted
to the handler before the router queues liquidity. If another account creates
the pair first, the unused factory allowance must be removed before continuing.

## Transactions And Recovery

Every write uses `createProviderWalletClient({client, provider, account,
networkHash})`, then `prepareExecution` with a 10,000,000 gas limit and 1,000-block
expiry. Signing returns approved bytes and their canonical hash. The app awaits
the workflow's `onSigned(hash)` persistence callback before submitting those
exact bytes through the extension. A failing callback never submits.

After submission begins, even an error may mean broadcast. The app observes the
original hash and returns a receipt, invalid result, or indeterminate state. It
never automatically re-signs. Receipt observation is signer-independent and
continues for an in-flight boundary after disconnection. Reconnect the same
account to recover its stored workflows in the UI. Do not clear uncertain
records or retry them as new transactions without authoritative resolution.

A successful router receipt means **queued**, not executed. Use **Crank queue**
to approve `process_requests()` through the extension. Processing is driver-wide
and may require multiple transactions. A committed crank alone does not prove
all requests finished; the app correlates handler/driver events by request ID.
For an uncertain crank, check its original hash instead of signing another one.

The app supports up to 10 pending swaps and reserves unresolved input balances
and allowances. It serializes approval/submission workflows across tabs. Quotes
use observed reserves, not projected queue order. The handler checks slippage
against reserves at execution time. History retains unresolved requests and up
to 50 terminal results in origin-scoped storage.

## Discovery And Deployment

Optional indexed token suggestions use `VITE_TOKEN_DISCOVERY_ENABLED`, the
launchpad factory/hash, and server-only `TOKEN_DISCOVERY_UPSTREAM_ORIGIN`.
Suggestions are hints, not an allowlist. Manual addresses and URL presets use
live metadata even during a registry outage. Saved recovery overrides presets.

The production Node process serves the SPA, pool registry, read-only RPC proxy,
indexer, and SQLite database. Set `.env.example` values at build and runtime;
`VITE_POOL_REGISTRY_ENABLED=true` enables this deployment. Startup verifies the
public build manifest before opening SQLite or listening. The manifest includes
`VITE_POOL_TOKEN_HASH` and allows an empty known-token list; it has no wallet
fields. The upstream RPC URL appears only as a SHA-256 digest. Browser RPC is
same-origin `/groundhog-rpc`, and write RPC methods remain forbidden even with a
connected wallet. Submission uses the extension's configured RPC instead.

```sh
npm --prefix apps/swap run build:production
npm --prefix apps/swap start
```

Use one replica and a volume at `/data` with `POOL_REGISTRY_DB_PATH=/data/pools.sqlite`.
Never share SQLite between replicas. Health is `/healthz`; indexer status is
`/api/registry/status`. Preserve WAL consistency when backing up the database.
Network/factory scope mismatches are fatal; do not edit stored scope metadata.

Set optional `VITE_EXPLORER_URL` to a root HTTPS origin, or exact loopback HTTP
origin. Blank disables links. Credentials, paths, queries, and fragments are
rejected. Links use `/address/<address>` or `/tx/<hash>` and open a new tab.
Rebuild when changing any public setting, including this URL.

## Verification

```sh
npm --prefix apps/swap test
npm --prefix apps/swap run typecheck
npm --prefix apps/swap run build:production
npm --prefix apps/swap run test:browser:tokens
```

Production builds deliberately fail when the configured hash-named artifact is
absent. For an isolated build check without changing a running setup, run
`npm --prefix apps/swap test -- server/pool-token-artifact.test.ts`. This builds
the actual app with a temporary `publicDir`, a correctly hashed serialization
fixture, and a temporary output directory. It checks the copied bytes and also
tests rejected assets; it does not claim contract-execution coverage.

Unit/component suites cover provider discovery and connection, identity changes,
disposal, disconnected observation, persistence-before-submit, ambiguous
submission, artifact integrity/bounds, routes, and the existing AMM workflows.
The Chromium token-input harness uses an explicitly non-signing public-identity
provider fixture; it is UI coverage, not extension or ledger acceptance.

Run `npm run test:e2e:wallet` from either app to build the extension and run
`scripts/test-wallet-extension.mjs` at the repository root.
Rerun it after the immutable artifact naming change; a prior run against
the legacy filenames does not validate this change. Cross-app acceptance must
demonstrate all of these on a fresh
ledger using the real extension, without pre-created user tokens or pools:

1. Provision infrastructure; assert empty factory and no wallet fields in env.
2. Create/fund an extension account, connect both apps, and launch two tokens.
3. Create the first pool with the LP artifact attached and verify initial liquidity.
4. Add/remove liquidity, swap, crank, and check on-chain balances and events.
5. Reject a signature, change accounts/network, lock/disconnect, and recover an
   ambiguous submitted hash without a second signature or submission.
6. Repeat connected writes against the production SPA while confirming that its
   public RPC proxy rejects submission and that its LP artifact is served.

Until that real-extension journey is recorded, passing unit/browser fixtures
must not be described as end-to-end acceptance.
