# Persistent Pool Registry for the Swap App

Status: Accepted for implementation
Date: 2026-09-05
Owners: Swap app maintainers

## Summary

The swap app currently discovers pools by enumerating the swap factory from every browser. This works for a small local deployment, but it does not provide shared searchable discovery, stable pagination, or a production service boundary.

Add a scope-bound SQLite registry to the swap app. A server-side indexer will consume canonical `PoolCreated` events from one configured swap factory, verify each event against factory state, and store immutable pool-creation evidence. The pools page will query this registry for discovery, then continue reading mutable pool and token state directly from the chain.

The registry is part of the swap app deployment. It is not a general protocol indexer and does not index swaps, liquidity operations, reserves, prices, balances, allowances, or transaction workflows.

## Goals

1. Make every retained factory-created pool discoverable by every user of the same deployment, while clearly reporting incomplete historical coverage.
2. Persist verified pool creation records across process restarts.
3. Replace per-browser full factory enumeration with bounded registry queries when enabled.
4. Support search, exact token filtering, deterministic sorting, and stable pagination.
5. Preserve live on-chain reads for mutable pool state and token metadata.
6. Preserve direct factory discovery as a local-development and disabled-registry fallback.
7. Package the SPA, registry API, indexer, SQLite owner, and read-only RPC proxy in one production process.
8. Fail closed on scope mismatches and conflicting canonical evidence.

## Non-goals

- Indexing swaps, mints, burns, reserves, prices, liquidity, balances, allowances, requests, or workflow state.
- Importing metadata from the token launchpad registry.
- Persisting token names, symbols, decimals, or logos.
- Supporting multiple networks or swap factories in one database.
- Supporting multiple SQLite writers or horizontal replicas.
- Accepting pool records or metadata from browsers.
- Inferring a pool creator. The current `PoolCreated` event does not identify one.
- Providing an unauthenticated production transaction relay.
- Replacing the swap factory's canonical on-chain registry.
- Deploying the service as part of this change.

## Existing Behavior

The swap factory stores an order-independent pair map and an append-only `all_pairs` vector. The browser currently reads `all_pairs_length`, calls `pair_at` for every entry, resolves each pool through `get_pair` and `pool_addresses`, reads token metadata and pool snapshots, and skips entries whose live reads fail.

This has several limitations:

- Every browser repeats the complete enumeration.
- The directory rejects more than 100 pools.
- There is no server-side search, filtering, sorting, or pagination.
- Discovery results are not shared or persisted off chain.
- A transient read failure can hide an otherwise valid pool from one browser.

Direct pair routes remain useful because they resolve and verify one requested pair without depending on directory discovery. This behavior must remain available.

## Source of Truth

The blockchain remains authoritative. SQLite is a rebuildable projection.

This design relies on Groundhog committed blocks and event identities being final. Finality is a documented deployment prerequisite validated by Groundhog platform compatibility tests, not a property exposed by `groundhog_networkInfo`. If the target network can reorganize committed blocks, deployment is unsupported until rollback handling is specified and implemented.

Only canonical `PoolCreated` events emitted by the configured factory may create registry records. Browser requests cannot create, edit, or delete records. The sync endpoint is only a freshness hint.

Each decoded event must be verified against factory state before it is committed:

1. The event emitter equals the configured factory.
2. `token0` and `token1` are nonzero, distinct, and canonically ordered.
3. `pair_count` is positive.
4. `get_pair(token0, token1)` equals the event handler.
5. `pool_addresses(token0, token1)` equals the event liquidity-token, handler, and driver addresses.
6. `pair_at(pair_count - 1)` equals `[token0, token1]`.
7. `get_pair`, `pool_addresses`, and `pair_at` are retried until they are read at one coherent live block height at or after the event block. These factory entries are immutable after creation; historical views are not required.
8. Observed `pair_count` values are contiguous after the known retained prefix. A gap without an explicit retention response is an integrity fault.

Malformed events or contradictory factory state are integrity faults. They must not be silently skipped.

The factory's enumerable state provides an operator recovery and audit path, but the automated registry defined here indexes creation events as required. It must not synthesize event provenance from state enumeration.

Before serving, before each scan, and before committing each page, the source verifies `groundhog_networkInfo` against the configured network ID. A mismatch fails closed. Operators must configure an upstream consistently bound to one network; the checks detect but cannot prevent an endpoint changing identity between requests.

## Deployment Topology

One Node process owns:

- One SQLite connection.
- One pool creation indexer.
- The registry HTTP API.
- A read-only Groundhog JSON-RPC proxy.
- The built SPA and route fallback.

The process runs as one Railway replica with one persistent volume. SQLite is not shared between processes.

The implementation intentionally mirrors the proven token-launchpad registry's module boundaries, recovery semantics, validation rules, HTTP hardening, and deployment model. It remains inside the swap app rather than extracting a generic shared indexing framework: pool evidence and verification are domain-specific, and the two apps must retain independent release and storage boundaries.

Local Vite development may continue using its existing loopback proxy and disposable personas. Registry support is feature-gated so existing direct discovery remains usable without the production server.

## Registry Scope

A database is permanently bound to:

- The normalized Groundhog network ID.
- The canonical swap factory address.

The current factory interface does not expose its configured child code hashes, so the registry must not claim to verify or bind them. Event records are instead cross-checked against the factory's public `get_pair`, `pool_addresses`, and `pair_at` views.

On startup:

- A new database stores the configured scope.
- An existing database must contain exactly the same scope.
- A missing, malformed, or mismatched scope aborts startup.
- Operators must restore matching configuration or use a fresh database; editing scope metadata is unsupported.

## Pool Record

Each immutable record contains:

- `networkId`: 32-byte lowercase hexadecimal network ID without `0x`.
- `factoryAddress`: canonical 32-byte lowercase hexadecimal address with `0x`.
- `token0Address`: canonical lower-address token.
- `token1Address`: canonical higher-address token.
- `liquidityTokenAddress`: canonical LP token address.
- `handlerAddress`: canonical pool handler address and route identity.
- `driverAddress`: canonical request driver address.
- `pairCount`: canonical unsigned decimal string from the event.
- `transactionHash`: canonical 32-byte lowercase hash with `0x`.
- `eventSequence`: canonical u32 decimal string.
- `createdBlock`: canonical positive decimal string.
- `indexedAt`: server-generated ISO ingestion timestamp.

Protocol integers are stored as canonical decimal text. The Groundhog SDK exposes the current Rust event sequence type as a u32 represented by a JavaScript number at the RPC boundary; the source validates that bound and immediately converts it to decimal text. JavaScript numbers and SQLite signed integers must not persist or serialize block heights, sequence values, or pair counts. SQL numeric comparisons and ordering compare decimal string length first and lexical value second, including all block-snapshot predicates.

The registry must enforce uniqueness for:

- The canonical token pair.
- The event identity `(transactionHash, eventSequence)`.
- `handlerAddress`.
- `liquidityTokenAddress`.
- `driverAddress`.
- `pairCount`.

An identical duplicate is an idempotent no-op. `indexedAt` is ingestion metadata and is excluded from canonical evidence equality; replay preserves the original value. Any conflicting immutable evidence rolls back the complete page and enters an integrity fault.

## SQLite Design

Use `node:sqlite` with no ORM. The minimum Node version is 22.13.0.

Database settings:

- WAL journal mode.
- `synchronous=FULL`.
- Foreign keys enabled.
- Five-second busy timeout.
- Versioned schema migrations through `PRAGMA user_version`.
- Startup rejection of unsupported newer schema versions.

Writes use `BEGIN IMMEDIATE`. A fetched event page and its next durable cursor commit in one transaction. Scan completion advances the fully indexed block and clears in-progress scan state atomically.

Persistent state includes:

- `indexed_through_block`.
- `history_limited`.
- `sync_state`.
- `last_successful_sync_at`.
- `last_error`.
- `scan_anchor_block`.
- `scan_target_block`.
- `scan_next_cursor`.

## Indexing Algorithm

The indexer scans `PoolCreated` events in ascending canonical order.

1. A fresh registry starts at block 1.
2. An incremental scan starts at `indexed_through_block + 1`.
3. The first response fixes the scan target to its reported latest block.
4. Later pages do not move that target.
5. Events above the target are excluded from that scan.
6. Every accepted page atomically commits verified records and its opaque next cursor.
7. Completion atomically advances `indexed_through_block` to the target.

When complete history is available, the first event must have `pair_count = 1`. Every later event must increment the last persisted pair count by one. Whenever an initial or cursor-replay page explicitly reports a retention gap, its first retained event establishes a new missing-prefix baseline and all subsequent values must remain contiguous. This detects omitted middle events without inventing records for unavailable history.

The target prevents a continuously advancing chain tip from making one scan unbounded and defines the snapshot boundary used by registry queries.

### Cursor Recovery

An in-progress scan persists its anchor, target, and opaque cursor.

- Restart resumes the persisted cursor.
- An explicit invalid-cursor response clears only the cursor and replays from the persisted anchor.
- Replay relies on immutable event idempotency.
- Only one cursor replay is allowed per sync run.
- A repeated cursor is an integrity fault.
- Ordinary transport failures never reset the cursor.

### Retention Gaps

If the event source reports that requested history predates retained history on the initial or replay page, the registry marks `history_limited` permanently for that database. The API and UI must disclose that older pools may be missing.

A continuation page must not silently change the scan anchor due to retention. Such a response is an integrity fault.

### Retries and Faults

Transient failures retry up to three times with exponential backoff starting at 250 ms and capped at two seconds. Exhaustion records a public error bounded to 500 UTF-8 bytes and returns the indexer to idle; periodic sync may recover later.

Deterministic decoding, verification, duplicate-cursor, or immutable-conflict failures enter `integrityFault`. Automatic indexing stops until an operator corrects the deployment or database and restarts the service.

Concurrent sync requests coalesce into at most one trailing scan. Browser sync hints have a one-second process-wide cooldown. The sync interval defaults to five seconds and is configurable from 1,000 through 86,400,000 milliseconds. Event page size defaults to 200 and is configurable from 1 through 500. Opaque cursors are bounded to 4,096 characters, and event responses must not contain more records than the requested page size. Shutdown stops scheduling, aborts active RPC and backoff waits, and awaits active work before closing SQLite.

## HTTP API

All responses use JSON unless serving SPA assets. API errors have stable machine-readable codes and messages bounded to 500 UTF-8 bytes. Request targets are bounded to 8 KiB, request bodies to 1 MiB, and registry responses to 256 KiB.

### `GET /healthz`

Reports process and database readiness. RPC unavailability does not make the health endpoint fail after startup.

### `GET /api/registry/status`

Returns:

- Scope.
- Indexed-through block.
- Pool count.
- Sync state.
- Whether history is limited.
- Last successful sync time.
- Last bounded error.

### `POST /api/registry/sync`

Requests best-effort synchronization and returns current status. It accepts no body and cannot insert records. Requests are coalesced and rate-limited in process.

### `GET /api/pools`

Accepted query parameters:

- `q`: search across both token addresses, LP address, handler address, and driver address; maximum 100 UTF-8 bytes after normalization.
- `token`: exact canonical token address; matches either side of the pair.
- `sort`: `newest`, `oldest`, `token0`, or `token1`.
- `limit`: integer from 1 through 100; default 20.
- `offset`: integer from 0 through 10,000; default 0.
- `asOfBlock`: optional canonical decimal snapshot block.

Unknown or duplicate parameters are rejected. Search input is NFKC-normalized and compared case-insensitively. SQL wildcard characters are escaped and all values use bound parameters. A supplied `asOfBlock` above the latest fully indexed block is rejected, so future snapshots cannot shift while indexing progresses.

Responses include:

- Scope.
- Pool records.
- Total matching records.
- Effective limit and offset.
- `hasMore`.
- `asOfBlock`.
- `historyLimited`.

All records satisfy `createdBlock <= asOfBlock`. Clients retain the first page's `asOfBlock` while paging and clear it when search, filter, sort, scope, or manual refresh changes.

Sort order is deterministic:

- `newest`: created block descending, event sequence descending, token addresses ascending.
- `oldest`: created block ascending, event sequence ascending, token addresses ascending.
- `token0`: token0 ascending, token1 ascending, creation evidence ascending.
- `token1`: token1 ascending, token0 ascending, creation evidence ascending.

## Browser Behavior

`VITE_POOL_REGISTRY_ENABLED` selects discovery mode.

When disabled, the existing direct factory enumeration remains unchanged.

When enabled, the pools page:

1. Requests a registry page.
2. Strictly validates the complete response and configured scope.
3. Converts immutable records into pool identities.
4. Reads token metadata and current pool snapshots from the chain with at most four pool enrichments in flight.
5. Renders successful entries while reporting partial live-read failures.

The registry does not persist token metadata. Therefore address search is authoritative in this change. Once a page has been enriched, the browser may additionally match displayed symbols and names within that page, but it must not imply that such a local filter covers records outside the current server page. Cross-registry token metadata search is deferred.

The directory provides:

- Debounced address search.
- Exact “contains token” filtering.
- Newest, oldest, token-0, and token-1 sorting.
- Previous/next snapshot pagination.
- Sync, delayed, integrity-fault, and incomplete-history notices.
- A manual Refresh action.
- Distinct initial-loading, empty-directory, no-results, unavailable, and partial-live-data states.

Superseded registry and enrichment requests are aborted. Monotonic request IDs suppress stale completions. Registry records may render before live enrichment completes, but navigation must use canonical token addresses from the verified record.

After a sync hint, the page polls status once per second. Transient status failures display a warning and continue polling. Completion resets the snapshot and reloads the first page. Polling stops after completion or component cleanup.

Pool creation sends a best-effort sync hint as soon as the factory `createPool` stage is committed and verified. Registry failure never changes successful transaction or workflow state. Periodic indexing remains the correctness path.

## Production Security

The production process exposes only read operations to browsers.

The same-origin RPC proxy permits:

- `groundhog_networkInfo`.
- `groundhog_chainTip`.
- `groundhog_getEvents`.
- `groundhog_getTransactionReceipt`.
- `groundhog_getTransactionStatus`.
- `groundhog_view`.

It rejects `groundhog_sendRawTransaction`, batches, malformed envelopes, redirects, oversized requests, oversized responses, unsupported content types, and upstream non-success responses. Upstream URLs, response bodies, credentials, and internal errors are never reflected publicly.

The proxy validates each allowed method's parameter shape and bounds event page sizes. It applies bounded request concurrency and a per-client request rate limit. Views require canonical contract addresses and bounded encoded arguments; these controls prevent the public endpoint from becoming an unrestricted upstream-quota relay.

Because production has no secure wallet or relay boundary, `/pools/new` redirects to `/pools`, and write controls for swaps and liquidity are unavailable in read-only production mode. Local development retains all transaction workflows.

HTTP hardening includes exact route/method allowlists, bounded targets and bodies, security headers, request timeouts, static realpath containment, symlink-escape rejection, no API/RPC SPA fallback, immutable asset caching, and no-store configuration documents.

## Build and Runtime Configuration

A registry-enabled production build emits `groundhog-public-config.json`. It contains all behavior-affecting public configuration plus only a SHA-256 digest of the upstream RPC URL.

Startup strictly validates the manifest and requires exact semantic equality with runtime configuration. Mismatches identify the environment variable but never log either value. The browser bundle uses the same-origin RPC proxy and does not contain the upstream RPC URL.

Public configuration includes:

- RPC URL digest.
- Network ID.
- Wallet/caller address required by read adapters.
- Wallet entrypoint.
- Native HOG address.
- Swap factory address.
- Swap router address.
- Canonically normalized known-token addresses.
- Pool-registry feature flag.

Development personas and private keys are never emitted into production assets or manifests.

## Operations

Railway packaging uses:

- RAILPACK.
- `npm run build:production`.
- `npm run start`.
- `/healthz`.
- One replica.
- A persistent volume mounted at `/data`.
- `POOL_REGISTRY_DB_PATH=/data/pools.sqlite`.
- 30-second draining and health-check windows.
- Restart on failure with a bounded retry count.

Backups must capture the SQLite database consistently with WAL semantics. Operators may use SQLite's backup mechanism or stop the service before copying the database, WAL, and shared-memory files together.

## Testing Requirements

### Store

- Fresh schema, reopen, migration version, and unsupported-newer-version behavior.
- Missing and mismatched scope rejection.
- Atomic page and cursor persistence.
- Canonical validation at the store boundary.
- Identical duplicate idempotency.
- Conflicts by pair, event identity, child address, and pair count.
- Large decimal block values and u32 event-sequence bounds.
- Search, exact token filtering, every sort, and snapshot pagination.

### Chain Source

- Configured factory emitter restriction.
- Generated `PoolCreated` decoding.
- Canonical pair and address validation.
- Coherent factory verification through `get_pair`, `pool_addresses`, and `pair_at`.
- Pair-count validation.
- Network mismatch and runtime endpoint drift rejection.
- Contiguous pair-count enforcement, including retained-prefix behavior.
- Cursor and retention metadata preservation.
- Sanitized failures.

### Indexer

- Empty and multi-page scans.
- Fixed scan target.
- Durable mid-scan restart.
- Invalid cursor replay.
- Repeated cursor fault.
- Retention handling.
- Transient retries without cursor loss.
- Concurrent sync coalescing and cooldown.
- Integrity-fault shutdown.
- Graceful abort and stop.

### HTTP and Production

- Query and body validation.
- Security headers and request limits.
- API error sanitization.
- Read-only RPC allowlist and response bounds.
- Static traversal and symlink containment.
- SPA fallback boundaries.
- Exact build/runtime configuration matching.
- Graceful draining.

### Frontend

- Registry feature flag and direct fallback.
- Strict response validation.
- Search debounce, token filtering, sorting, and snapshot pagination.
- Live metadata and snapshot enrichment.
- Partial live-read failures.
- Stale request and stale enrichment suppression.
- Sync completion refresh and failed-poll retry.
- Best-effort post-creation sync hint.
- Read-only production routes.

### Clean-ledger Acceptance

Against one fresh local node:

1. Provision the standard seeded pool.
2. Create at least one additional distinct pool from another persona.
3. Verify direct factory discovery sees both pools.
4. Start a temporary SQLite registry with event page size one.
5. Verify both pools through an independent HTTP client.
6. Verify search, token filtering, oldest/newest sorting, and snapshot pagination.
7. Verify each record against factory state.
8. Stop the service and reopen the same database.
9. Verify both records remain available.
10. Confirm liquidity or swap activity neither creates nor mutates registry records.

The acceptance harness must restore generated local configuration and remove temporary registry files.

## Delivery Phases

1. Specification.
2. SQLite registry foundation, scope, queries, status, and base HTTP API.
3. Verified chain event source, durable indexer, and persistence acceptance.
4. Registry-backed pool directory, live enrichment, controls, and sync hints.
5. Combined production server, read-only proxy, configuration manifest, Railway packaging, and operational documentation.
6. Final independent review, full test suite, clean-ledger acceptance, and corrective hardening.

Each phase is reviewed, tested, and committed before the next begins.

## Acceptance Criteria

The work is complete when:

- Two users connected to the same deployment can discover each other's retained factory-created pools.
- Restarting the swap service preserves the directory.
- Only verified canonical `PoolCreated` evidence enters SQLite.
- Search, token filtering, sorting, and stable pagination work through the registry API and pools page.
- Mutable pool and token data still comes from the chain.
- Registry outages do not alter transaction success.
- Disabled registry mode preserves direct factory discovery.
- Production exposes no transaction submission path.
- Scope mismatches and immutable conflicts fail closed.
- Unit, integration, production, and clean-ledger acceptance tests pass.
