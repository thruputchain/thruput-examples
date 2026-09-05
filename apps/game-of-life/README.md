# Game of Life Explorer

React application for exploring synchronized immutable generations of the 10,000 by 10,000 Groundhog Game of Life world, admitting tick requests, and processing one queued generation at a time.

## Requirements

- Node.js 22.12 or newer
- Chromium at `/usr/bin/chromium`, or set `CHROMIUM_PATH`
- A fresh disposable `hog-devnode` 0.1.26 ledger and its runtime manifest
- A Groundhog CLI compatible with that node
- For clean-ledger acceptance, `sqlite3`, `flock`, `setsid`, and the devnode contract-artifact directory

## Local Development

Start a fresh disposable local node separately, then export its CLI and runtime manifest:

```bash
npm ci
export GROUNDHOG_CLI=/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/path/to/runtime-manifest.json

# Set this only when the node does not use the standard local RPC port.
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545

npm run setup:local
npm run dev
```

`setup:local` builds, prefunds, deploys, and initializes Game of Life through manifest-derived local accounts. It verifies the seed-zero world and the Alice, Bob, and Carol caller lifecycle before writing `.env.local`. Setup is not idempotent: if it fails after mutating the ledger, inspect the reported transaction and start a new disposable node rather than rerunning it.

`dev` builds and supervises the release indexer and Vite. It prints the app, indexer, and RPC URLs when both services are ready. Press `Ctrl-C` to stop those services; the separately started node remains running. Indexer state persists under the ignored `tmp/game-of-life-indexer` directory unless `GAME_OF_LIFE_ARTIFACT_ROOT` and `GAME_OF_LIFE_INDEXER_DB` override it.

## Transaction X-Ray

The read-only Transaction X-Ray at `/xray` shows one selected cell's exact neighborhood, Conway result, packed contract address, current bank value, and expected value at the same location in the next bank. It then connects that bit to one byte, one row, one 12.5 MB generation bank, and the 25 MB two-bank world. A local phase selector exposes the fixed work of one non-empty tick: 20,004 chunk reads, 12,502,500 bytes read, 100,000,000 scalar cell outcomes, 20,000 chunk writes, 12,500,000 bytes written, and one atomic bank, metadata, queue-slot, and event handoff. Transaction semantics and detailed derivations live in the [contract README](../../contracts/game-of-life/README.md).

The workload selector is explanatory UI, not transaction playback or timing evidence. It performs no network request and X-Ray provides no wallet, tick request, crank, signing, or live-run integration. Live transaction controls remain in the World application.

The initial route loads chain metadata plus the latest immutable manifest and provenance. It requests no tile or canonical chunk payload. Activating **Inspect exact cell** fetches only the level-six exact tiles needed for the selected cell's toroidal 3 by 3 neighborhood: one tile normally and at most four at tile or world boundaries. It performs no adjacent prefetch.

The resulting cell values are immutable, digest-scoped indexer artifacts. The indexer verifies its complete canonical download against the on-chain digest, but individual tile bytes do not carry independent proofs. The browser derives the selected cell's expected Conway result from those nine values; that result is explanatory and does not become canonical until a contract invocation commits the next generation.

### Route and Hosting

Production hosts must rewrite both `/xray` and `/xray/` to `/index.html`; the client selects the route after startup. Do not redirect these paths to `/`, because shared X-Ray URLs preserve `cellX`, `cellY`, and unrelated query parameters. Local Vite development, preview, and deterministic fixture servers already provide this fallback.

### Read-Only Runtime Boundary

The X-Ray route does not initialize personas, wallet material, signing, submission, transaction records, Deck.gl, Luma.gl, or the World renderer. A production-build plugin follows the emitted X-Ray chunk graph and fails the build if that graph reaches private transaction or world-rendering modules. The same-origin RPC proxy exposes read methods only outside credential-enabled local development.

### Evidence Sources and Reconciliation

X-Ray keeps these sources distinct:

- **Contract-derived:** fixed by the pinned encoding and algorithm.
- **Chain metadata:** returned by the current validated contract view.
- **Indexer-attested provenance:** validated identity and publication information for an immutable snapshot.
- **Browser-derived:** calculated from displayed immutable inputs, such as one Conway rule result.
- **Receipt-measured:** decoded from a committed transaction receipt.
- **Benchmark-measured:** recorded with a versioned method and environment.
- **Configured limit:** an execution budget, never measured consumption.
- **Illustrative:** explanatory structure or motion, never timing evidence.

Chain metadata and indexer snapshots poll independently. Their relationship can be aligned, indexer behind, chain only, retained snapshot, incompatible refresh, integrity conflict, or unavailable. A temporary failure preserves the last valid identity with a stale label. Regressions, scope mismatches, malformed artifacts, and same-generation digest conflicts never replace valid evidence.

### Chain, Indexer, and Browser Responsibilities

| Zone    | Responsibility                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chain   | Owns canonical banks, metadata, queue semantics, rule evaluation, digest, population, and atomic commit.                                         |
| Indexer | Downloads a complete immutable generation, verifies its digest, and publishes scoped manifests, provenance, density tiles, and exact-cell tiles. |
| Browser | Validates configured scope and document agreement, requests only data needed by the current view, and presents source-qualified values.          |

Neither the indexer nor browser can replace the chain's authority or compute canonical next state.

### Claim and Comparison Guardrails

The execution-envelope table compares the fixed workload with published chain limits. On Groundhog protocol `hogp/81e1cb073cfb`, one transaction evaluated all 100,000,000 cells, wrote the complete 12,500,000-byte destination bank, and committed in 7.04 seconds locally.

The Solana column cites the official [account limits](https://solana.com/docs/core/accounts), [compute-budget documentation](https://solana.com/docs/core/fees), and [SBF instruction meter](https://github.com/anza-xyz/sbpf/blob/v0.13.1/src/vm.rs) for Agave `v3.1.8`. A 12,500,000-byte bank exceeds the 10,485,760-byte account maximum by 2,014,240 bytes and must be split across at least two accounts. More decisively, the 1,400,000-CU transaction cap leaves 0.014 CU for each of 100,000,000 scalar cell outcomes. Assigning only one metered SBF instruction, one CU, to each cell would require 100,000,000 CU, 71.4 times the cap, before the actual rule, reads, or writes.

The Ethereum column cites the currently documented [60-million-gas block limit](https://ethereum.org/en/developers/docs/blocks/), [EVM opcode costs](https://ethereum.org/en/developers/docs/evm/opcodes/), and the final [EIP-2930](https://eips.ethereum.org/EIPS/eip-2930) access-list cost of 1,900 gas per storage key. A 12,500,000-byte bank occupies 390,625 32-byte storage slots. The EIP-2930 storage-key entries alone cost 742,187,500 intrinsic gas, 12.4 times the current documented block limit, before the address entry, normal transaction gas, `SSTORE`, or Conway computation; cold access costs more. The block limit also leaves only 0.6 gas per scalar cell. Assigning only one PUSH0-priced, 2-gas opcode to each cell would cost 200,000,000 gas before the actual rule or storage work.

Comparisons with other systems must use the same 100-million-cell workload and atomicity definition, a versioned implementation, reproducible measurements, and explicit admission, execution, state-delta, block-production, finality, and data-availability assumptions. The application makes no unsupported cross-system ranking.

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

Provision the contract and generate the loopback-only Alice, Bob, and Carol configuration on a fresh disposable node:

```bash
GROUNDHOG_CLI=/path/to/validated/groundhog \
GROUNDHOG_RUNTIME_MANIFEST=/path/to/runtime-manifest.json \
GROUNDHOG_RPC_URL=http://127.0.0.1:9545 \
GAME_OF_LIFE_INDEXER_URL=http://127.0.0.1:8787 \
npm run setup:local
```

Setup validates the `hog-devnode` 0.1.26 runtime, wire format, DevWallet hash and entrypoints, storage model, and manifest accounts. It prefunds and deploys the deterministic contract through the manifest-derived faucet and Alice wallets, then uses the proven Rust live harness to initialize and verify all 100 million cells. It funds each persona, writes the ignored `.env.local` with mode `0600`, submits one request from each persona, verifies each emitted caller, processes the queue through Bob, and verifies an empty no-op. This caller check advances the disposable world by at least three generations; run it before starting the indexer. A failed check restores any prior `.env.local` or removes the generated file so writes cannot remain enabled with an unverified caller.

The generated transaction policies are the measured local profiles: request `100,000` outer/target gas with a 64-block expiry and 30-second observation window; crank `10,010,000,000` outer gas, `10,000,000,000` target gas, a two-block expiry, and a 300-second observation window.

Credential injection occurs only during `vite serve`. The development server rejects non-loopback hosts, cross-site requests, and mismatched origins before serving credential-bearing modules. The proxy enables submission, status, and receipt RPC methods only in that mode. These keys are disposable local-ledger credentials, not production custody.

## Commands

```bash
npm ci
GROUNDHOG_CLI=/path/to/validated/groundhog npm run generate:contracts
npm run setup:local
npm run dev
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

The command starts an ephemeral three-account node, invokes the normal `setup:local` path, starts the normal `dev` supervisor with isolated storage and random ports, advances one generation through Chromium, waits for verified publication and renderer ownership, reloads durable transaction state, restarts the indexer, and tears down every process it owns. It restores any pre-existing `.env.local`. No ledger, private key, SQLite database, tile tree, or machine-specific address survives in tracked files.

Machine-readable results are written to ignored files in `benchmark-results/phase-7-*`. The live browser run records whether p95 interaction frames remain below 16.7 ms for its desktop viewport and 33.3 ms for its mobile viewport. Both run under Chromium with SwiftShader on the same host; they prove browser correctness and repeatable software profiling, not physical mobile GPU performance. The committed reference run missed the strict desktop budget before rounding and therefore does not complete the physical-device performance gate.

## Dependency Review

`npm audit --omit=dev` currently reports eight high-severity entries in the `@deck.gl/geo-layers` dependency chain. They lead to denial-of-service advisories in `image-size` through glTF and texture-compression modules. This application imports `TileLayer` for the World route but does not load glTF, 3D Tiles, compressed textures, or user-supplied images. A production-build plugin fails the build if the X-Ray chunk graph reaches Deck.gl, Luma.gl, world rendering, development personas, or transaction modules. npm's proposed remediation downgrades deck.gl from 9.3.10 to 8.9.36, which conflicts with the verified renderer stack. Keep the pinned version until the deck.gl chain publishes a compatible fix, and reassess before any non-local deployment or expansion of accepted artifact formats.

## Boundaries

- Chain metadata, the latest pointer, immutable artifacts, and indexer status poll independently while the document is visible. Failures use bounded exponential backoff and visibility restoration refreshes every source.
- Chain, candidate preparation, renderer transition, and visualized snapshot are independent state. Status becomes stale at 15 seconds and affects health messaging only.
- The first eligible snapshot remains an epoch-bound candidate until its current viewport has digest-qualified GPU coverage and confirmed hidden and revealed frames. Missing, malformed, unavailable, or allocation-failed resources never gain visualization ownership.
- At most eight tile fetches and two decode workers run concurrently across both digest layers.
- Visible requests share seven slots and cancellable idle prefetch shares one; prefetched tiles are decoded into the shared digest-keyed CPU cache.
- A 32 MiB shared decoded cache and two 16 MiB deck tile caches cap aggregate CPU ownership at 64 MiB. Live app-owned GPU allocations have a separate 64 MiB budget.
- Density tiles are exact unsigned 16-bit little-endian counts. Exact tiles retain bit-packed LSB-first bytes for inspection and upload an integer cell texture.
- The immutable pyramid ends at exact level six; the camera can overzoom those cells to 16 pixels square with nearest-neighbor sampling, an adaptive grid, and exact hover highlighting.
- The browser requires immutable artifacts to match the configured world and either current chain metadata or valid retained event provenance. Metadata-observation provenance is current-only.
- The configured indexer verifies the complete snapshot against the on-chain digest. Individual tile bytes do not carry proofs.
- A temporary chain or indexer failure keeps the last verified snapshot visible. Regressions and same-generation digest conflicts never replace it.
- A newer digest is loaded in a separate layer. Level six requires digest-qualified GPU resources for every selected tile; density levels permit render-ready selected tiles or their immediate parents. The old layer remains opaque while the candidate fades over it with straight-alpha blending. Ownership changes only after coverage, a confirmed rendered frame, and current epoch/digest/chain approval; reduced motion switches without blending through the same gate.
- Request and crank histories are separate versioned records scoped by network, expected caller, and Life contract. The same scope controls an exclusive Web Lock, migrations, signing, and cross-tab reconciliation.
- The canonical transaction hash is persisted before submission. Invalid, failed, pending, indeterminate, accepted, untracked, advanced, no-work, and incompatible outcomes remain distinct. Indeterminate transactions are observed by their original hash and never retried automatically.
- `TickRequested` is the only acceptance proof. `GenerationAdvanced` completes a local request only when its request ID and requester match. A crank can accurately report processing another persona's request without completing the wrong local record.
- Automatic mode submits at most one crank after durable admission while retaining the same lock. Manual mode separates request-only and process-one controls. Mounts, reloads, account switches, indexer updates, and event polling never initiate writes.
- Local RPC event retention is finite. If retained history no longer covers an unresolved request, the record becomes permanently unknown instead of failed or complete.
