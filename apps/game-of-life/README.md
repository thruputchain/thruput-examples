# Game of Life Explorer

React application for exploring synchronized immutable generations of the 10,000 by 10,000 Groundhog Game of Life world, admitting tick requests, and processing one queued generation at a time.

## Requirements

- Node.js 22.12 or newer
- Chromium at `/usr/bin/chromium`, or set `CHROMIUM_PATH`
- A loopback Groundhog RPC endpoint and Phase 3 indexer
- An initialized Game of Life contract and runtime manifest from the same node
- For clean-ledger acceptance, `sqlite3`, a Groundhog CLI 0.10.1-compatible devnode, and its `built_contracts` directory

## Configuration

Set these public values before starting or building. Configuration is validated before React mounts.

```text
VITE_GROUNDHOG_RPC_URL=http://127.0.0.1:9545
VITE_GROUNDHOG_NETWORK_ID=<64 hexadecimal characters>
VITE_GAME_OF_LIFE_CONTRACT_ADDRESS=<canonical lowercase 0x-prefixed 32-byte address>
VITE_GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787
```

The indexer URL must be an origin root. Paths, queries, and fragments are rejected.

The browser always uses same-origin `/groundhog-rpc` and `/groundhog-indexer` endpoints. Production builds and previews expose read methods only and never contain development credentials.

Generate the loopback-only Alice, Bob, and Carol configuration after deployment and initialization:

```bash
GROUNDHOG_CLI=/path/to/validated/groundhog \
GROUNDHOG_RUNTIME_MANIFEST=/path/to/runtime-manifest.json \
GROUNDHOG_RPC_URL=http://127.0.0.1:9545 \
GROUNDHOG_CONTRACT_ADDRESS=0x... \
GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787 \
npm run setup:local
```

Setup validates the pinned local DevWallet artifact and entrypoint, derives each disposable signer from the runtime manifest, verifies its public key and wallet root, funds each persona for a full crank, and writes the ignored `.env.local` with mode `0600`. It serializes environment writers with an advisory lock, then submits one request from each persona, verifies each emitted caller, processes the queue through Bob, and verifies an empty no-op. This caller check advances the disposable world by at least three generations; run it before starting the indexer. A failed check restores any prior `.env.local` or removes the generated file so writes cannot remain enabled with an unverified caller.

The generated transaction policies are the measured local profiles: request `100,000` outer/target gas with a 64-block expiry and 30-second observation window; crank `10,010,000,000` outer gas, `10,000,000,000` target gas, a two-block expiry, and a 300-second observation window.

Credential injection occurs only during `vite serve`. The development server rejects non-loopback hosts, cross-site requests, and mismatched origins before serving credential-bearing modules. The proxy enables submission, status, and receipt RPC methods only in that mode. These keys are disposable local-ledger credentials, not production custody.

## Commands

```bash
npm ci
GROUNDHOG_CLI=/path/to/validated/groundhog npm run generate:contracts
npm run check:contracts
npm run typecheck
npm test
npm run test:chromium
RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 npm run test:integration:local
npm run test:e2e:local
npm run build
npm run verify
```

The generated contract binding is committed so a fresh checkout can build without the Groundhog CLI. Regeneration first builds `game-of-life`, then replaces the binding from `target/groundhog/game_of_life.spec.xdr`. `check:contracts` generates into a temporary directory and compares without modifying the committed file. It uses `GROUNDHOG_CLI` when set, otherwise `groundhog` from `PATH`. `verify` runs the contract check, formatting check, typecheck, unit tests, and production build; Chromium and live acceptance remain separate commands. Build, Playwright, benchmark, coverage, and local environment outputs are ignored.

## Clean-Ledger Acceptance

Run the complete 100-million-cell demonstration with no node already active:

```bash
GROUNDHOG_CLI=/path/to/groundhog \
GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
GROUNDHOG_CONTRACT_ARTIFACTS_DIR=/path/to/built_contracts \
GROUNDHOG_E2E_HOGD_PROTOCOL=hogp/<compatible-protocol> \
npm run test:e2e:local
```

The command starts an ephemeral three-account node, builds and deploys the contract, prefunds its deterministic address, initializes all 100 million cells, verifies Alice, Bob, and Carol, starts the indexer and app, advances one generation through Chromium, waits for verified publication and renderer ownership, reloads durable transaction state, restarts the indexer, and tears down every process. It restores any pre-existing `.env.local` and project Groundhog configuration. No ledger, private key, SQLite database, tile tree, or machine-specific address survives in tracked files.

Machine-readable results are written to ignored files in `benchmark-results/phase-7-*`. The live browser run records whether p95 interaction frames remain below 16.7 ms for its desktop viewport and 33.3 ms for its mobile viewport. Both run under Chromium with SwiftShader on the same host; they prove browser correctness and repeatable software profiling, not physical mobile GPU performance. The committed reference run missed the strict desktop budget before rounding and therefore does not complete the physical-device performance gate.

## Dependency Review

`npm audit --omit=dev` currently reports eight high-severity entries in the `@deck.gl/geo-layers` dependency chain. They lead to denial-of-service advisories in `image-size` through glTF and texture-compression modules. This application imports `TileLayer` but does not load glTF, 3D Tiles, compressed textures, or user-supplied images, and those parsers are absent from the production browser bundle. npm's proposed remediation downgrades deck.gl from 9.3.10 to 8.9.36, which conflicts with the verified renderer stack. Keep the pinned version until the deck.gl chain publishes a compatible fix, and reassess before any non-local deployment or expansion of accepted artifact formats.

## Boundaries

- Chain metadata, the latest pointer, immutable artifacts, and indexer status poll independently while the document is visible. Failures use bounded exponential backoff and visibility restoration refreshes every source.
- Chain, candidate preparation, renderer transition, and visualized snapshot are independent state. Status becomes stale at 15 seconds and affects health messaging only.
- The first eligible snapshot remains an epoch-bound candidate until its current viewport has digest-qualified GPU coverage and confirmed hidden and revealed frames. Missing, malformed, unavailable, or allocation-failed resources never gain visualization ownership.
- At most eight tile fetches and two decode workers run concurrently across both digest layers.
- Visible requests share seven slots and cancellable idle prefetch shares one; prefetched tiles are decoded into the shared digest-keyed CPU cache.
- A 32 MiB shared decoded cache and two 16 MiB deck tile caches cap aggregate CPU ownership at 64 MiB. Live app-owned GPU allocations have a separate 64 MiB budget.
- Density tiles are exact unsigned 16-bit little-endian counts. Exact tiles retain bit-packed LSB-first bytes for inspection and upload an integer cell texture.
- The browser requires immutable artifacts to match the configured world and either current chain metadata or valid retained event provenance. Metadata-observation provenance is current-only.
- The configured indexer verifies the complete snapshot against the on-chain digest. Individual tile bytes do not carry proofs.
- A temporary chain or indexer failure keeps the last verified snapshot visible. Regressions and same-generation digest conflicts never replace it.
- A newer digest is loaded in a separate layer. Level six requires digest-qualified GPU resources for every selected tile; density levels permit render-ready selected tiles or their immediate parents. The old layer remains opaque while the candidate fades over it with straight-alpha blending. Ownership changes only after coverage, a confirmed rendered frame, and current epoch/digest/chain approval; reduced motion switches without blending through the same gate.
- Request and crank histories are separate versioned records scoped by network, expected caller, and Life contract. The same scope controls an exclusive Web Lock, migrations, signing, and cross-tab reconciliation.
- The canonical transaction hash is persisted before submission. Invalid, failed, pending, indeterminate, accepted, untracked, advanced, no-work, and incompatible outcomes remain distinct. Indeterminate transactions are observed by their original hash and never retried automatically.
- `TickRequested` is the only acceptance proof. `GenerationAdvanced` completes a local request only when its request ID and requester match. A crank can accurately report processing another persona's request without completing the wrong local record.
- Automatic mode submits at most one crank after durable admission while retaining the same lock. Manual mode separates request-only and process-one controls. Mounts, reloads, account switches, indexer updates, and event polling never initiate writes.
- Local RPC event retention is finite. If retained history no longer covers an unresolved request, the record becomes permanently unknown instead of failed or complete.
