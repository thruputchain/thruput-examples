# Token Launchpad Persistent Registry

**Status:** Implementation plan  
**Date:** 2026-09-05  
**Application:** `apps/token-launchpad`

## 1. Executive Summary

### Problem Statement

The token launchpad currently discovers only the latest retained `TokenCreated` events from the configured factory. Discovery is repeated in each browser, limited to 100 events, and cannot guarantee that a token remains visible across machines or after event retention advances.

### Proposed Solution

Add a small same-origin HTTP service backed by SQLite. The service indexes canonical `TokenCreated` events from one configured network and factory, stores immutable creation metadata and provenance, and exposes a bounded search API. The production process also serves the built launchpad SPA, making one Railway service and one persistent volume sufficient.

The blockchain remains authoritative. Browsers never submit token metadata for storage. A successful browser launch may request an immediate index sync, but the server accepts a token only after reading and validating its factory event from the configured RPC. A periodic server-side sync provides eventual recovery when the browser request is lost.

### Success Criteria

- A token indexed on one machine appears on another machine through the registry API.
- Restarting the service against the same SQLite file preserves indexed tokens and resumes from its durable chain cursor.
- Name, symbol, token address, and creator searches return a bounded page in under 200 ms for 10,000 local records.
- Duplicate event delivery is idempotent; conflicting immutable evidence fails without overwriting existing data.
- The launchpad remains usable with direct chain discovery when the registry is not configured.
- A Railway deployment requires one service, one persistent volume, and documented environment variables.

## 2. User Experience And Functionality

### User Personas

- **Token creator:** launches a token and expects it to become discoverable for other users.
- **Token explorer:** searches and sorts factory-created tokens from any machine.
- **Operator:** deploys one launchpad service, configures its chain scope, and attaches durable storage.

### User Stories

#### Persistent Discovery

As a token explorer, I want the directory to use a shared registry so that previously indexed tokens remain visible across browsers and machines.

Acceptance criteria:

- `/tokens` reads the configured registry when registry support is enabled.
- `/my-tokens` sends the active wallet address as a creator filter.
- Registry records survive process restarts when the same SQLite file is reused.
- Registry downtime produces an actionable retry state and never changes on-chain state.
- When registry support is disabled, the existing direct-chain directory remains available.

#### Search, Filter, And Sort

As a token explorer, I want basic query controls so that I can find tokens without scanning the full directory.

Acceptance criteria:

- Search matches case-insensitive token name, symbol, exact or partial token address, and exact or partial creator address.
- Creator filtering accepts one canonical 32-byte address.
- Sorting supports newest, oldest, name, and symbol.
- Every response is paginated with a default of 20 and a maximum of 100 records.
- The first page fixes an indexed-block snapshot that subsequent pages reuse, preventing duplicates or omissions while newer tokens are indexed.
- Invalid query parameters return `400` with a bounded public error.

#### Prompt Post-Launch Discovery

As a token creator, I want a successful launch to appear promptly without making registry availability part of transaction success.

Acceptance criteria:

- After committed creation evidence is persisted, the browser requests a registry sync when registry support is enabled.
- Sync failure does not mark the transaction failed or discard receipt evidence.
- The service coalesces concurrent sync requests.
- Periodic sync eventually indexes the event if the browser request never arrives.

#### Railway Operation

As an operator, I want conventional build, start, and health commands so that deployment is straightforward.

Acceptance criteria:

- The server binds to `0.0.0.0:$PORT` in production.
- Static assets receive immutable caching while `index.html` does not.
- Unknown non-API routes fall back to `index.html` for `BrowserRouter`.
- `/healthz` verifies process and database readiness without contacting the chain.
- `/api/registry/status` reports chain scope, indexed height, retention coverage, last success, and a bounded last error.
- The documented Railway configuration mounts a volume at `/data` and sets the SQLite path beneath it.

### Non-Goals

- A hosted database, ORM, authentication system, or administrator dashboard.
- Multi-network or multi-factory aggregation in one deployment.
- Horizontal scaling or multiple SQLite writers.
- User profiles, favorites, analytics, or arbitrary token submissions.
- Replacing chain state with database state.
- Continuously indexing balances, total supply, allowances, or mutable wallet state.
- Deploying contracts or Railway services in this workstream.
- Adding production wallet integration to the launchpad or swap app.

## 3. Technical Specifications

### Architecture Overview

```text
Groundhog RPC
    |
    | ascending TokenCreated pages
    v
Registry indexer ---- atomic transaction ----> SQLite on Railway volume
    |                                           |
    | periodic sync / browser sync hint         | indexed query
    v                                           v
POST /api/registry/sync                 GET /api/tokens
                                                    |
                                                    v
                                           Launchpad directory
                                                    |
                                                    | live balance views
                                                    v
                                               Groundhog RPC
```

One Node process owns the SQLite connection, index loop, API, and static file serving. The implementation uses `node:sqlite` on Node 22.13 or newer and the existing Groundhog TypeScript client and generated event decoder. No database package or web framework is required.

### Trust Model

`TokenCreated` emitted by the configured factory is the canonical discovery and provenance record. The indexer must:

1. Construct a pinned Groundhog cluster so client startup verifies the RPC network hash.
2. Read the configured factory's immutable `config()` and require its token implementation hash to equal the configured standard-token hash.
3. Persist one canonical network, factory, and implementation-hash scope in SQLite and reject reuse of the database under another scope.
4. Query only the configured factory address.
5. Decode only `TokenCreated` events.
6. Require every event token implementation hash to equal the configured standard-token hash.
7. Canonicalize all addresses and hashes before persistence.
8. Validate metadata byte limits, decimals, non-negative supply, block height, and event sequence.
9. Reject conflicting immutable evidence for an existing token or event identity.

The browser cannot insert or update token records. `POST /api/registry/sync` contains no token metadata and only asks the server to poll its configured RPC.

### Stored Data

The registry stores fields needed for durable discovery, search, provenance, and deterministic ordering:

- Network ID.
- Factory address.
- Token address.
- Creator address.
- Administrator address at creation.
- Initial holder address.
- Initial supply as canonical decimal text.
- Name and symbol from the creation event, including nullability.
- Decimals from the creation event, including nullability.
- Token implementation hash.
- Creation transaction hash.
- Event sequence number.
- Creation block height as canonical decimal text.
- Index timestamp.

The registry does not store balances, current total supply, allowances, funding values, or browser workflow state. The browser continues to read the active wallet balance from the chain for displayed records.

### SQLite Schema

Schema versioning uses `PRAGMA user_version`. Version 1 contains:

```sql
CREATE TABLE registry_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE registry_scope (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  network_id TEXT NOT NULL,
  factory_address TEXT NOT NULL,
  token_code_hash TEXT NOT NULL
);

CREATE TABLE tokens (
  network_id TEXT NOT NULL,
  factory_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  administrator_address TEXT NOT NULL,
  initial_holder_address TEXT NOT NULL,
  initial_supply TEXT NOT NULL,
  name TEXT,
  symbol TEXT,
  search_name TEXT,
  search_symbol TEXT,
  decimals INTEGER,
  token_code_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  block_height TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (network_id, factory_address, token_address),
  UNIQUE (network_id, transaction_hash, event_sequence)
);
```

Indexes support creator filtering, creation ordering, and normalized name/symbol ordering. Numeric protocol values that may exceed SQLite's signed 64-bit range are stored as validated decimal text. Sort comparisons use decimal string length and lexical order where numeric ordering is required.

Search normalization uses JavaScript `NFKC` normalization followed by locale-independent lowercase conversion when records are indexed and when queries are parsed. SQL `LIKE` escapes literal `%`, `_`, and the escape character. A bounded scan across at most 10,000 rows is acceptable for substring search; this phase does not add FTS.

Database initialization enables WAL, `synchronous=FULL`, foreign keys, and a bounded busy timeout. Migrations execute transactionally. Unsupported newer schema versions fail startup rather than guessing compatibility.

### Indexing And Cursor Semantics

- Initial sync starts at block 1 and queries events in ascending order.
- Incremental sync starts at `indexed_through_block + 1`.
- Durable in-progress scan state contains the fixed scan anchor, opaque next-page cursor, and the first page's `latestBlock` target.
- Each page is bounded to 200 events and follows opaque RPC cursors until exhausted.
- Repeated cursors fail the sync to prevent an infinite loop.
- Each page's decoded records and next cursor commit in one SQLite transaction.
- Only an exhausted cursor clears in-progress scan state and advances `indexed_through_block` to the scan's fixed `latestBlock` target.
- Restart resumes the stored opaque cursor. If the RPC rejects that cursor, the indexer clears only the cursor, restarts from the stored scan anchor, and relies on event-identity deduplication.
- Duplicate identical events are no-ops.
- Conflicting records abort the transaction and surface a degraded status.
- If the RPC reports that retained history starts after the requested initial or resume height, status is marked `historyLimited` and the directory labels results as incomplete.
- Sync requests are coalesced so only one chain scan runs at a time.
- `POST /api/registry/sync` observes a global cooldown, schedules or joins background work, and returns immediately.
- A periodic loop runs every five seconds by default.
- Transient transport, timeout, and upstream-availability errors retry with bounded backoff without changing the cursor.
- Invalid opaque cursors replay from the stored scan anchor.
- Malformed canonical events, wrong implementation hashes, and immutable-evidence conflicts are terminal integrity faults. They preserve cursor state, stop automatic syncing, and require an operator restart after the underlying configuration or data problem is corrected.
- Shutdown stops scheduling work, aborts the active RPC request, awaits sync finalization, closes HTTP, and then closes SQLite. If the platform's shutdown deadline expires first, the process exits without explicitly closing SQLite rather than racing an active database operation.

This feature starts with a fresh schema and does not migrate browser event history or any previous server database.

### HTTP API

#### `GET /healthz`

Returns `200` when the server initialized the schema and can execute a trivial database query. Returns no chain secrets or internal paths.

#### `GET /api/registry/status`

Returns:

```json
{
  "networkId": "hex",
  "factoryAddress": "0x...",
  "indexedThroughBlock": "123",
  "tokenCount": 42,
  "historyLimited": false,
  "syncState": "idle",
  "syncing": false,
  "lastSuccessfulSyncAt": "2026-09-05T12:00:00.000Z",
  "lastError": null
}
```

`syncState` is one of `idle`, `syncing`, `retrying`, or `integrityFault`, allowing operators and the UI to distinguish transient degradation from a terminal fault that requires intervention.

#### `POST /api/registry/sync`

Schedules or joins an immediate background sync and returns `202` with current status. The route accepts no request body and enforces one process-wide cooldown. It is a freshness hint, not a token registration endpoint. Clients observe completion through `/api/registry/status` or a later list request.

#### `GET /api/tokens`

Query parameters:

- `q`: optional trimmed search text, maximum 100 UTF-8 bytes.
- `creator`: optional canonical `0x`-prefixed 32-byte address.
- `sort`: `newest` (default), `oldest`, `name`, or `symbol`.
- `limit`: integer from 1 to 100, default 20.
- `offset`: integer from 0 to 10,000, default 0.
- `asOfBlock`: optional canonical decimal block height returned by the first page.

Response:

```json
{
  "tokens": [],
  "total": 0,
  "limit": 20,
  "offset": 0,
  "asOfBlock": "123",
  "hasMore": false,
  "historyLimited": false
}
```

Offset pagination is sufficient for the intended small devnet registry and keeps the API and UI simple. The first response captures the current fully indexed height as `asOfBlock`; subsequent requests include it and query only records at or below that height. Every sort includes token address as a final deterministic tie-breaker.

### Frontend Integration

Registry support is controlled by `VITE_TOKEN_REGISTRY_ENABLED=true`. The browser uses same-origin `/api` routes; no browser-visible API secret exists.

When enabled:

- `TokensPage` queries the registry with search, creator, sort, limit, and offset.
- Browser chain reads use same-origin `/groundhog-rpc`; only the production server knows the remote devnet RPC URL.
- The page debounces search input and resets pagination when search, scope, or sort changes.
- Each returned token is enriched with the active wallet's current balance through bounded parallel chain views.
- Registry event metadata is used for immediate rendering and search; chain view failures affect only live balance enrichment.
- A registry status warning identifies incomplete retained history or sync errors.
- A committed creation requests an immediate sync without changing launch success semantics.

When disabled, the existing `readCreatedTokens` event path remains unchanged for local development and focused chain testing.

### Production Server

The production server:

- Validates all required environment at startup.
- Opens one SQLite database.
- Starts the indexer and HTTP listener.
- Serves `/api/*`, `/healthz`, `/groundhog-rpc`, built assets, and SPA fallback routes.
- Proxies a read-only allowlist of Groundhog JSON-RPC methods with request, response, timeout, content-type, and redirect limits. Transaction submission remains disabled until production wallet support and relay abuse controls are designed.
- Adds `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, and frame-denial headers.
- Does not inject or serve disposable development private keys.

The production app and server share the same public chain scope. Build-time `VITE_*` values and server runtime values must match; startup logs a bounded scope summary to aid deployment checks.

### Configuration

Required production variables:

- `PORT` supplied by Railway.
- `TOKEN_REGISTRY_DB_PATH`, recommended `/data/token-registry.sqlite`.
- `VITE_GROUNDHOG_RPC_URL`, a credential-free HTTP or HTTPS devnet endpoint.
- `VITE_GROUNDHOG_NETWORK_ID`.
- `VITE_STANDARD_TOKEN_FACTORY_ADDRESS`.
- `VITE_STANDARD_TOKEN_HASH`.
- The remaining public `VITE_*` launchpad configuration values required by the existing frontend build.

Optional variables:

- `TOKEN_REGISTRY_SYNC_INTERVAL_MS`, default `5000`, minimum `1000`.
- `TOKEN_REGISTRY_PAGE_SIZE`, default `200`, maximum `500`.

Frontend configuration retains the existing `VITE_*` names and adds `VITE_TOKEN_REGISTRY_ENABLED=true`. Railway supplies the same public variables during build and runtime, so the server and generated frontend cannot be configured from separate names. Server startup independently verifies the RPC network, factory configuration, and persisted database scope.

For registry-enabled production builds, the configured upstream RPC URL is used only by the server and is compiled to same-origin `/groundhog-rpc` in browser configuration. Vite's loopback-only RPC validation continues to protect credential-bearing local development but does not reject a credential-free HTTPS production upstream. The production server validates that upstream independently.

### Security And Privacy

- SQL uses bound parameters only.
- API request targets, methods, body sizes, query sizes, and response sizes are bounded.
- Error responses and logs pass through bounded public messages and never include private keys, signed transactions, database paths, or raw upstream bodies.
- CORS is unnecessary because the production API is same-origin.
- Sync requests are coalesced and rate-limited per process.
- Terminal integrity faults stop automatic indexing instead of retrying deterministic failures indefinitely.
- Static path resolution rejects traversal and never serves files outside `dist`.
- The SQLite file and WAL files are excluded from Git.
- The Railway service runs one replica. Scaling beyond one replica requires replacing SQLite and is out of scope.

## 4. Testing Strategy

### Store Tests

- Fresh schema creation and reopening.
- Unsupported schema rejection.
- Atomic record and cursor persistence.
- Idempotent duplicate insertion.
- Conflicting immutable evidence rejection.
- Search, creator filter, every sort, bounds, pagination, and deterministic ties.
- Values above signed 64-bit and JavaScript safe-integer ranges.

### Indexer Tests

- Multi-page ascending ingestion and durable resume.
- Crash recovery from a committed mid-scan cursor and safe replay after cursor rejection.
- Repeated cursor rejection.
- Malformed event and wrong implementation hash rejection.
- Retention-gap reporting.
- Coalesced concurrent sync.
- RPC failure followed by successful retry.

### HTTP Tests

- Health, status, list, and sync success paths.
- Invalid methods, content types, bodies, query values, paths, and traversal attempts.
- Static asset cache policy and SPA fallback.
- Bounded public errors and security headers.

### Frontend Tests

- Search debounce and stale-response suppression.
- Creator filter for `/my-tokens`.
- Sort and pagination resets.
- Stable `asOfBlock` pagination while new tokens are indexed.
- Registry loading, empty, populated, unavailable, and incomplete states.
- Active-wallet balance enrichment and partial failures.
- Best-effort post-launch sync.
- Existing direct-chain fallback behavior.

### Acceptance Tests

1. Start a disposable node and registry with a temporary SQLite file.
2. Provision the factory.
3. Launch tokens as Alice and Bob.
4. Trigger registry sync and query from a separate HTTP client.
5. Verify global search, symbol search, creator filtering, sorting, and pagination.
6. Restart the registry with the same database and verify both tokens remain visible.
7. Run the production server and load `/tokens`, `/my-tokens`, and `/create` through headless Chromium.

## 5. Delivery Phases

### Phase 1: Specification

- Commit this architecture, trust model, schema, API, deployment, and test plan.

### Phase 2: SQLite Registry And HTTP Foundation

- Add configuration parsing, schema management, store queries, API parsing, health/status routes, a runnable server entrypoint, and tests.
- Keep the indexer behind an interface so store and HTTP behavior remain deterministic in tests.

### Phase 3: Chain-Verified Indexing

- Add Groundhog event pagination, validation, durable cursor updates, periodic sync, and sync hints.
- Extend live acceptance to prove persistence and cross-client discovery.

### Phase 4: Launchpad Directory Integration

- Add the registry client, search/sort/pagination controls, active-wallet balance enrichment, stale-request protection, and post-launch sync.
- Preserve direct-chain fallback when registry support is disabled.

### Phase 5: Railway Production Packaging

- Extend the server with static SPA serving and a read-only production RPC proxy. Add production build/start commands, Railway configuration, volume guidance, health check, and deployment documentation.
- Do not deploy from this branch.

### Phase 6: Final Verification

- Run all app, server, live acceptance, browser, formatting, audit, and repository checks.
- Perform a full branch review and fix concrete findings.
- Stop after a clean final commit; do not create or submit a pull request without approval.

## 6. Risks And Mitigations

- **Event retention gap:** expose incomplete status; deploy the indexer with the factory and sync continuously.
- **RPC outage:** retain existing rows and cursor, expose degraded status, and retry transient failures without advancing state.
- **Integrity fault:** retain records and cursor, stop automatic retries, expose the bounded fault, and require operator intervention.
- **SQLite volume loss:** document Railway volume attachment and backup responsibility; health cannot substitute for backups.
- **Concurrent process writers:** document and enforce one replica; SQLite is intentionally not a horizontal-scaling design.
- **Poisoned browser submissions:** browsers cannot submit records; the server indexes only allowlisted factory events.
- **Registry delays launch completion:** sync hints are best-effort and independent from transaction success.
- **Large directory:** cap queries and offsets; 10,000 records is the design target, not internet-scale discovery.
- **Scope mismatch:** verify RPC identity and immutable factory configuration, bind each database to one scope, expose that scope in status, and use the same public variable names at build and runtime.
