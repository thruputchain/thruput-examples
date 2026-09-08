# Launchpad To Swap Operations

Start with [wallet local development](wallet-local-development.md) for dependency
installation, sequential infrastructure setup, extension loading, and the
two-token journey. Both apps use external wallets, not setup-generated personas.
Wallet permission is separate for each app origin.

## Handoff

Set launchpad's `VITE_SWAP_APP_URL=http://127.0.0.1:5174` for the local pair of
apps. After committed token creation and complete verification, **Create AMM
Pool** passes the actual token address as `tokenA`. It does not wait for indexing,
transfer wallet permissions, or submit a transaction. Blank configuration hides
the CTA.

A two-token link is `/pools/new?tokenA=<address>&tokenB=<address>` on the Swap
origin. Presets preserve A/B order and contain addresses only, never amounts or
approval. Swap reads live metadata before review; editing does not rewrite the
URL. Existing recovery takes precedence over presets.

CTA and optional `VITE_EXPLORER_URL` values must be root origins: HTTPS outside
exact loopback HTTP hosts, with no credentials, path, query, or fragment. Explorer
links use `/address/<address>` and `/tx/<hash>`; blank disables them. These URLs
do not authenticate a network. Operators must align app, wallet, and explorer
networks and rebuild production assets after public setting changes.

## Optional Local Discovery

Neither registry is needed to launch tokens or create pools by address. Swap's
indexed token suggestions require launchpad's **built production registry
service**, not its Vite server on 5173. Keep the interactive apps on 5173/5174 and
run the registry separately on 3001 when desired.

Retain generated infrastructure values and configure Swap's `.env.local`:

```dotenv
VITE_POOL_REGISTRY_ENABLED=false
VITE_TOKEN_DISCOVERY_ENABLED=true
TOKEN_DISCOVERY_UPSTREAM_ORIGIN=http://127.0.0.1:3001
```

Also copy `VITE_STANDARD_TOKEN_FACTORY_ADDRESS` and `VITE_STANDARD_TOKEN_HASH`
from launchpad. Do not replace Swap's factory, router, or `VITE_POOL_TOKEN_HASH`.
Restart Swap's Vite server after changing configuration.

From the repository root, build launchpad with registry mode enabled:

```sh
VITE_TOKEN_REGISTRY_ENABLED=true npm --prefix apps/token-launchpad run build:production
```

Then, from **`apps/token-launchpad`**, start its separate server:

```sh
VITE_TOKEN_REGISTRY_ENABLED=true PORT=3001 \
  TOKEN_REGISTRY_DB_PATH=./token-registry.sqlite \
  node --env-file=.env.local --import tsx server/main.ts
```

The server does not load `.env.local` itself; `--env-file` supplies it, and explicit
process values override it. Use identical public values for build and runtime.
Keep `VITE_TOKEN_REGISTRY_ENABLED=false` for the interactive launchpad Vite app.
Use a fresh database path for each new ledger/scope and only one writer per
SQLite file. Do not reuse port 3001 for an explorer at the same time.

## Production Packaging

Enable `VITE_TOKEN_REGISTRY_ENABLED=true` for launchpad and
`VITE_POOL_REGISTRY_ENABLED=true` for Swap. Follow each app's README and
`.env.example` for its full configuration. Include the built sibling
`groundhog-client-ts` at the same relative path in the build context; a standalone
app directory cannot install the current `file:` dependency. No SDK publish or
push is needed for this workstream.

Deploy matching public configuration and immutable artifacts together:

- Launchpad requires `contract-artifacts/${VITE_STANDARD_TOKEN_HASH}.json`.
- Swap requires `contract-artifacts/${VITE_POOL_TOKEN_HASH}.json`.
- Filenames include the lowercase `0x`-prefixed hash. The exact JSON schema is
  `{ "contractType": "rv32", "data": "0x...", "hash": "0x..." }`.
- Production builds and startup validate artifact schema and computed hash.
  Missing or corrupt assets fail closed. Neither stage runs setup or repairs
  artifacts; do not substitute mutable `erc20.json` or `standard-token.json` files.
- Public manifests require exact build/runtime agreement, including optional
  public settings and a digest of the upstream RPC URL. Rebuild on configuration
  or manifest-schema changes; do not edit the generated manifest to bypass checks.

Provide no private keys, persona settings, or browser wallet identities to the
build or server. Production pool creation and other connected UI writes remain
available: the extension signs and submits to its own configured RPC. App
`/groundhog-rpc` proxies remain read-only and reject transaction submission and
airdrop methods, even when a wallet is connected. Disconnected browsing requires
no wallet.

For discovery, set server-only `TOKEN_DISCOVERY_UPSTREAM_ORIGIN` to the HTTPS
**root origin** of the launchpad registry. Never use a path, API key,
browser-supplied URL, or broad CORS rule. Keep this upstream out of `VITE_*`.
The browser uses same-origin `GET /api/token-discovery?q=...`; status and token
pages are fetched server-side. Discovery failure does not determine deployment
health.

Use one replica and one persistent SQLite database per service. `/healthz` checks
database access, not chain availability; `/api/registry/status` reports indexing
progress. Backups must preserve WAL consistency. For network/factory/hash scope
mismatches, restore matching configuration or attach a fresh database; never edit
stored scope metadata. Retained chain history may not cover all earlier events.

## Recovery And Acceptance

- Search covers name, symbol, token address, and creator address; only the newest
  20 matches are offered. Refine broad queries.
- No match or registry outage does not invalidate a token. Use manual addresses
  and retry live metadata reads. Indexed metadata is not authoritative review.
- Network mismatch blocks signing and live review. Correct infrastructure and
  wallet configuration, not the token address. Registry scope mismatch rejects
  suggestions but leaves independent manual live reads available.
- A queued request is not delivered liquidity. Approve queue processing and
  verify reserves and LP balances. Retain uncertain transaction hashes and observe
  them; do not clear recovery records or resubmit as a new transaction.

See [wallet acceptance](wallet-acceptance.md) for the current isolated
real-extension runner, prerequisites, evidence, and limits. The old seeded-persona
`test:e2e:local`, `test:integration:local`, and `test:e2e:cross-app` commands have
been replaced by `test:e2e:wallet` in both apps. The older cross-app acceptance record predates
provider wallets. Current wallet acceptance includes production-server smoke,
but does not establish cross-app discovery or remote production deployment.
