# Groundhog 100 Million Cell Game of Life Frontend
Status: Draft

Date: 2026-08-27
## Summary
Build a responsive web application that makes the canonical 10,000 by 10,000 Groundhog Game of Life world explorable without loading or rendering 100 million DOM elements. The application uses an imperative WebGL2 tiled viewport backed by an off-chain snapshot indexer. It reads authoritative metadata and transaction events from Groundhog, while immutable visualization tiles provide efficient world exploration.

The primary action submits a commuting `request_tick()` transaction. After that request commits, the default flow submits one permissionless `process_next_tick()` transaction. These remain separate transactions, and the interface must not imply that the crank processes the caller's request.

This specification depends on [Groundhog 100 Million Cell Game of Life Contract](./2026-08-27-game-of-life-contract.md). The contract specification is authoritative for world encoding, digest construction, queue semantics, events, and transaction behavior.

Version one is a local-development demonstration. The frontend, indexer, artifact storage, RPC, and disposable wallets run on loopback interfaces. A later devnet deployment may replace the storage and wallet adapters, but it must first satisfy the same finality, archival-event, snapshot-consistency, and credential requirements.
## Demonstration Claim
The interface should make this precise claim visible:

> One Groundhog contract invocation reads, computes, and commits the exact next state of a persistent 100-million-cell Conway world atomically.

The interface must not claim that the browser or indexer computed the canonical generation. The indexer derives visualization artifacts from state already committed by the contract.
## Goals
- Show the complete 10,000 by 10,000 world as a smooth pan-and-zoom surface.

- Preserve individual-cell detail at close zoom and exact aggregate live-cell counts at lower zooms.

- Keep chain metadata, indexed snapshots, and displayed generations visibly distinct.

- Never replace a complete displayed generation with a partial new one.

- Let many users submit commuting tick requests while presenting the serial crank honestly.

- Persist transaction identities and lifecycle state across reloads and tabs.

- Recover safely from disconnects, timeouts, conflicts, excluded transactions, and delayed indexing.

- Work on narrow mobile screens, tablets, and desktop displays.

- Define the browser's verification and trust boundary precisely.

## Non-Goals
- Rendering one DOM node per cell.

- Downloading all 12.5 MB of canonical chunks during ordinary page load or navigation.

- Computing a canonical next generation in the browser or indexer.

- Editing cells, uploading patterns, changing rules, or resetting the world.

- Displaying authoritative queue depth, queue position, wait time, or fairness.

- Guaranteeing that a user's crank processes that user's request.

- Continuous browser-based keeping or repeated automatic cranking.

- Historical retention guarantees beyond snapshots retained by the indexer.

- Per-tile cryptographic proofs in version one.

- Production wallet integration in the first local-development version.

- Hosting the frontend or indexer on devnet in version one.

## Product Model
The interface tracks three independent generation values:

- **Chain generation** is returned by the contract's current `get_metadata()` view.

- **Preparing generation** is a chain generation that the indexer has observed but has not published.

- **Visualized generation** is the immutable manifest currently displayed by the renderer.


These values may differ. A successful crank advances the chain immediately, but visualization follows only after the indexer downloads, verifies, derives, and publishes the new snapshot. The previous visualized generation remains interactive during that interval.

Never label the visualized generation as current when its digest differs from current chain metadata. Use explicit text such as **Generation 42 on-chain; displaying 41 while 42 is prepared**.
## Primary User Flow
1. Load contract metadata and the latest ready visualization manifest independently.

2. Validate that the configured world dimensions and tile schema are supported.

3. Display the newest ready generation whose identity matches current metadata or a retained committed event, and identify whether it matches the chain generation.

4. Let the user pan, zoom, inspect coordinates, and read density or exact cell state.

5. When the user activates **Advance 100,000,000 cells**, submit `request_tick()`.

6. Treat the request as accepted only after a committed receipt contains a valid `TickRequested` event.

7. Persist the accepted request before creating any crank attempt.

8. In automatic mode, submit exactly one `process_next_tick()` transaction.

9. Reconcile any `GenerationAdvanced` event in the crank receipt, even when it belongs to another requester.

10. Continue observing the user's accepted request by `request_id` until its own `GenerationAdvanced` event appears.

11. Keep the old snapshot visible while the indexer prepares the new chain generation.

12. Switch to the new manifest only after its visible tiles are ready; never flash an empty or mixed-generation viewport.

## Interface
### Visual Direction
Use a dark, full-bleed simulation viewport rather than a dashboard of cards. The world should read as a large scientific instrument:

- Near-black canvas with a restrained sequential density ramp.

- Distinct live cells and optional grid lines only at close zoom.

- A compact top bar for identity, network, and settings.

- A floating generation and population readout that does not obscure the world.

- A scale indicator and current coordinate readout.

- A minimap showing the viewport footprint within the fixed world.

- One prominent **Advance 100,000,000 cells** action.

- A compact activity surface for request, crank, and indexing status.


Avoid decorative particles, simulated cell animation, or transitions that imply intermediate canonical states. A generation changes atomically; the visual transition may crossfade complete snapshots but must not morph cells through invented states.
### World Interaction
- Pan with pointer drag, touch drag, trackpad, or keyboard.

- Zoom around the pointer or gesture centroid with wheel, pinch, keyboard controls, and accessible buttons.

- Clamp the camera to the 10,000 by 10,000 world with a small overscroll margin; spring back when the gesture ends.

- Provide **Fit world** and **Reset north-up** controls. Rotation is not supported.

- At maximum detail, show exact integer `x` and `y`, live/dead state, and generation under the pointer.

- Below maximum detail, show the exact live count and covered-cell count for the sampled density pixel rather than inventing a cell state.

- Do not issue `get_cell()` RPC calls on pointer movement. Tile bytes supply inspection data.

- Preserve camera position when a new generation appears.

- Encode optional camera state as bounded URL query values so a location can be shared without persisting high-frequency state.

### Generation Presentation
- Show chain generation, visualized generation, population, state digest abbreviation, and indexing state.

- Show full digest, seed, dimensions, contract address, and source block in a details sheet.

- Distinguish **On-chain**, **Preparing visualization**, **Ready**, **Displaying older generation**, and **Indexer unavailable** with text and iconography, not color alone.

- A successful `GenerationAdvanced` event updates chain status immediately. It does not make tiles ready.

- An unavailable indexer must not block contract reads or transaction recovery. Keep the last complete snapshot and explain that visualization updates are unavailable.

### Transaction Presentation
- Keep request lifecycle separate from crank lifecycle.

- Request states are **Signing request**, **Request outcome uncertain**, **Request accepted**, **Awaiting processing**, and **Generation produced**.

- Crank states are **Preparing crank**, **Signing crank**, **Crank outcome uncertain**, **Crank committed**, **Crank found no work**, and **Crank failed**.

- A committed crank can advance another request. Say **A queued generation was advanced** unless the receipt's `request_id` matches the user's record.

- A failed or uncertain crank does not relabel an accepted request as failed.

- After bounded visible observation time, use **Accepted; processing not yet observed**. Absence of an event does not prove failure.

- Automatic mode may show a compact latest activity. Manual mode exposes complete retained history, hashes, recovery controls, and **Process one queued tick**.

### Processing Mode
- Automatic mode is active on every mount and submits one crank after one uninterrupted successful request admission.

- An advanced **Manual queue processing** switch is session-only and off by default.

- The selected mode at submission start governs that request.

- Mode changes never sign or submit a transaction.

- Automatic mode must not crank on mount, reload, mode change, request recovery, indexer updates, or merely because accepted work exists.

- A recovered request admission never initiates a crank automatically.

- Manual mode permits explicit request-only submissions and explicit one-at-a-time cranks.


Model this as one submission-time boolean, `crankAfterAdmission`, captured when the user starts the action. It causes exactly one crank only when durable acceptance occurs in that same in-memory workflow; remount and recovery clear the opportunity.
### Responsive Behavior
Desktop uses the full viewport with floating controls and a right-side activity sheet. Mobile keeps the world full-screen, places primary controls above the safe-area inset, and moves details and activity into bottom sheets.

- The viewport must remain usable at 320 CSS pixels wide and in landscape mobile orientation.

- Floating controls must avoid browser safe areas and must not cover the primary action.

- Touch controls need at least 48 by 48 CSS pixel targets.

- Sheets must leave enough world visible to preserve spatial context where practical.

- The top bar collapses secondary metadata into a details sheet below the desktop breakpoint.

- Text must remain legible over the simulation through opaque or strongly blurred surfaces.

- Respect `prefers-reduced-motion`; replace crossfades and spring effects with immediate state changes.

- Support keyboard operation, visible focus, accessible names, and a polite live region for meaningful lifecycle changes.

- Do not announce camera movement, tile loading, or repeated polling.

## Visualization Architecture
### Coordinate System
World coordinates are integer cells from `(0, 0)` through `(9,999, 9,999)`, with `(0, 0)` at the top left. The viewport uses continuous world coordinates and a fixed unrotated projection.

Use these constants:

```text
WORLD_WIDTH = 10,000
WORLD_HEIGHT = 10,000
TILE_SIZE = 256 texels
MAX_ZOOM = 6
```

At zoom level `z`, one texel covers this square cell region:

```text
cells_per_texel(z) = 2^(MAX_ZOOM - z)
tile_span(z) = TILE_SIZE * cells_per_texel(z)
tile_count_axis(z) = ceil(10,000 / tile_span(z))
```

This produces 1, 2, 3, 5, 10, 20, and 40 tiles per axis for levels zero through six. Edge tiles are zero-padded outside the world. The camera remains bounded to the real 10,000-cell extent, not the padded tile extent.

For world coordinate `(x, y)` at level `z`:

```text
tile_x = floor(x / tile_span(z))
tile_y = floor(y / tile_span(z))
local_cell_x = x - tile_x * tile_span(z)
local_cell_y = y - tile_y * tile_span(z)
texel_x = floor(local_cell_x / cells_per_texel(z))
texel_y = floor(local_cell_y / cells_per_texel(z))
texel_index = texel_y * 256 + texel_x
```

A density texel's covered-cell count is the area of its cell-space square intersected with `[0, 10,000) * [0, 10,000)`. At level six, the cell byte is `local_cell_y * 32 + floor(local_cell_x / 8)`, and the bit is `local_cell_x % 8`.
### Tile Formats
Every tile is immutable and has no per-file header. Its manifest defines the schema, dimensions, and content type. Index calculations use row-major order.

Levels zero through five are exact density tiles:

```text
content type: application/vnd.groundhog.life-density-u16le
length: 256 * 256 * 2 = 131,072 bytes
value: exact live-cell count in the texel's covered square
encoding: unsigned 16-bit little-endian
outside-world cells: excluded from covered-cell count and encoded as zero
```

The renderer derives density as `live_count / covered_cell_count`. At level zero, one texel covers at most 4,096 cells, so `u16` cannot overflow.

Level six contains exact cell tiles:

```text
content type: application/vnd.groundhog.life-cells-v1
length: 256 rows * 32 bytes = 8,192 bytes
encoding: row-major, LSB-first bits within each byte
outside-world cells: zero
```

Level-six encoding matches the contract's canonical bit order within each tile row. Do not expand exact cells to one byte each on the wire. A worker may unpack visible tiles into an `R8` upload buffer. Density inspection reads retained decoded `u16` bytes for one discrete texel. Rendering may upload density as `R16UI` with nearest-neighbor integer sampling; visual interpolation must not alter the count reported by inspection.

Files must be served without content transformation that changes decoded bytes. HTTP content encoding such as Brotli is allowed. Clients validate decoded byte length before use.
### Tile Paths
Use network and contract identity plus the complete lowercase state digest:

```text
/v1/worlds/{networkId}/{contractAddress}/{stateDigest}/manifest.json
/v1/worlds/{networkId}/{contractAddress}/{stateDigest}/provenance.json
/v1/worlds/{networkId}/{contractAddress}/{stateDigest}/tiles/{z}/{x}/{y}.bin
/v1/worlds/{networkId}/{contractAddress}/latest.json
```

`networkId` omits `0x`; contract and digest use lowercase `0x`-prefixed hexadecimal. Reject path components that are not canonical before storage lookup.
### Ready Manifest
An immutable ready manifest has this logical schema:

```ts
interface LifeManifestV1 {
  schemaVersion: 1;
  networkId: string;
  contractAddress: string;
  generation: string;
  seed: string;
  width: 10000;
  height: 10000;
  population: string;
  stateDigest: string;
  tileSize: 256;
  maxZoom: 6;
  densityEncoding: "u16le-live-count";
  cellEncoding: "row-major-lsb-first";
  tilePathTemplate: "tiles/{z}/{x}/{y}.bin";
  verification: {
    canonicalDownloadVerified: true;
    individualTileProofs: false;
  };
}
```

Decimal `u64` values are strings. Addresses and hashes use canonical lowercase hexadecimal. Reject unknown schema versions, wrong dimensions, unsupported encodings, malformed values, and path templates that escape the manifest origin or digest directory.

`latest.json` is a small mutable pointer containing `schemaVersion`, `generation`, `stateDigest`, `manifestUrl`, `sourceBlockHeight`, `sourceBlockHash`, and `publishedAt`. Observation and publication fields remain outside the digest-addressed manifest so rebuilding one state produces identical immutable bytes. The browser treats the immutable manifest as authoritative for tile interpretation, not the pointer.
### Cache Policy
- Digest-addressed manifests and tiles use `Cache-Control: public, max-age=31536000, immutable` and stable strong ETags.

- `latest.json` uses `Cache-Control: no-cache` so revalidation is cheap but freshness is preserved.

- A snapshot is ready only when both immutable `provenance.json` and `manifest.json` exist and agree. The manifest is the final commit marker. Failed builds may leave byte-identical orphan tiles or provenance at final digest paths, but no manifest or latest pointer may reference an incomplete build.

- Do not reuse a digest path with different bytes.

- A service worker is optional. Version one should rely on HTTP caching and a bounded in-memory tile cache unless offline support is explicitly added.

- Retain at least the current ready digest and its predecessor, plus a configurable grace period after pointer promotion. Larger historical retention remains optional.

## Snapshot Indexer
### Local Deployment
Implement version one as one Rust binary at `helpers/game-of-life-indexer`. Run exactly one writer per configured network and contract. The service uses SQLite for event cursors, verified generation evidence, and restart state; it reconstructs derivation jobs from chain metadata and published manifests rather than requiring a distributed job queue.

Publish manifests, provenance, and tiles to a local filesystem root. Create temporary files in the destination directory, write and file-`fsync` them, atomically rename them, then `fsync` the parent directory. Refuse startup when the configured filesystem cannot provide same-filesystem atomic rename and the required durability semantics. Serve those files and the required status endpoint over a loopback-only HTTP listener. Derive strong ETags from immutable bytes. The single writer performs the generation comparison before atomically replacing `latest.json`.

Keep publication behind a narrow storage interface so a future devnet deployment can add a strongly consistent object-store implementation with conditional pointer replacement. Distributed writers, cloud storage, and hosted operations are outside version one.

### Ingestion Sources
Acquire one committed generation through the first compatible source in this order:

1. A committed transaction or development-detail response containing the complete destination-bank storage delta and resulting metadata.
2. A block-pinned storage-delta subscription, batch view, range read, or equivalent node API.
3. The portable `get_metadata()` plus 20,000 `get_chunk()` view fallback.

Every source must yield the same canonical 12,500,000 bytes and pass the complete population and state-digest verification. A transaction delta is usable only when it includes every written chunk value, deterministic keys, the metadata update, and committed block identity. Metrics or changed-key lists without values are insufficient.

For the local fallback, the demo does not intentionally run a continuous keeper while a generation is being indexed. If views cannot be pinned and another generation commits during download, discard the build and retry after activity settles. A future continuously advancing devnet deployment requires committed-delta ingestion or block-pinned historical reads.

### Responsibilities
The indexer observes chain metadata, acquires canonical chunks from a supported ingestion source, verifies one coherent generation, derives the tile pyramid, archives verification evidence, and publishes it atomically. It never submits transactions and never predicts future generations.

For each unindexed generation:

1. Read `get_metadata()` and retain the source block identity when the RPC supports pinned views.

2. Reject metadata unless width and height are 10,000, `chunk_bytes` is 1,000, and `chunks_per_row` is two.

3. Acquire all 20,000 canonical chunks from the selected ingestion source. The view fallback uses configured concurrency, per-call timeout, maximum attempts, and exponential backoff.

4. Normalize source data to the contract's actual 1,000-byte head and 250-byte tail chunks. For `get_chunk()`, ignore the tail response's 750 transport-padding bytes.

5. Reconstruct the 12,500,000 canonical bytes in row and chunk-key order.

6. Recompute population and the contract's streaming state digest.

7. Reject the snapshot unless seed, width, height, generation, population, and digest match metadata.

8. If reads were not pinned to one block, read metadata again and reject unless generation and digest remain identical.

9. Build exact level-six cell tiles from canonical bytes.

10. Build density levels by summing child cell regions, never by averaging already quantized color values.

11. Validate every tile's length, range, coordinates, and aggregate counts.

12. Write every tile to its final digest-addressed path through the local atomic filesystem publisher.

13. Verify the final tile objects, write and verify immutable `provenance.json`, then write the immutable manifest last as the readiness commit marker.

14. Confirm that the manifest is readable before comparing the candidate with the current pointer and atomically replacing `latest.json`.

15. Replace the pointer only when the candidate generation is greater than the stored generation, or equal with the same digest. Conditional object-version replacement is required only for a future multi-writer storage adapter.


If the chain advances during an unpinned download, discard the mixed snapshot and retry from new metadata. Anchor provenance to the final matching metadata observation's committed block height and hash. If the RPC cannot supply that block identity, verification may complete for diagnostics but publication is prohibited. Never splice chunks from different generations or publish based only on sampled cells.
### Invariants
- The sum of every level's density counts equals the manifest population.

- Every density parent equals the sum of the exact child regions it covers.

- Reassembling level-six tiles reproduces the canonical world bytes and digest.

- A ready manifest references only existing complete tiles.

- A failed build leaves the previous latest pointer unchanged.

- Reprocessing the same `(network, contract, digest)` produces byte-identical tiles and manifest bytes.

- A delayed or retried older build cannot move `latest.json` backward.

### Observation And Scheduling
- Observe `WorldInitialized` and `GenerationAdvanced` events, with periodic `get_metadata()` polling as recovery.

- Deduplicate work by `(networkId, contractAddress, stateDigest)`.

- Process only committed chain state.

- Coalesce obsolete pending generations when historical retention is not required, but never interrupt publication after the latest pointer could reference the build.

- Expose health and preparation status separately from the public ready manifest.

- Apply bounded retries with backoff. Corrupt or unverifiable snapshots require operator-visible errors, not silent publication.

- Persist every verified `WorldInitialized` and `GenerationAdvanced` identity in SQLite for the local contract's lifetime and write one immutable provenance sidecar per published digest.


This specification treats a committed Groundhog block and receipt as final. Compatibility testing must confirm that assumption. If the target network can reorganize committed blocks, deployment is blocked until the indexer and browser define confirmation depth, event rollback, and orphaned-manifest invalidation.
### Indexer API
Version one exposes static artifact reads plus a required status endpoint:

```text
GET /v1/worlds/{network}/{contract}/latest.json
GET /v1/worlds/{network}/{contract}/{digest}/manifest.json
GET /v1/worlds/{network}/{contract}/{digest}/provenance.json
GET /v1/worlds/{network}/{contract}/{digest}/tiles/{z}/{x}/{y}.bin
GET /v1/worlds/{network}/{contract}/status.json
```

`provenance.json` records schema version, network, contract, generation, seed, population, digest, source block height and hash, evidence kind, transaction hash and event index when applicable, event kind, request ID and requester for `GenerationAdvanced`, and verification time. It is immutable after first publication and uses the same long-lived cache policy as the manifest.

The required status response has this logical schema:

```ts
interface LifeIndexerStatusV1 {
  schemaVersion: 1;
  state: "idle" | "preparing" | "error";
  observed: { generation: string; stateDigest: string } | null;
  preparing: {
    generation: string;
    stateDigest: string;
    completedUnits: number;
    totalUnits: number;
    unit: "chunks" | "tiles" | "files";
  } | null;
  published: { generation: string; stateDigest: string } | null;
  retry: { attempt: number; nextAt: string } | null;
  errorCode: string | null;
  heartbeatAt: string;
}
```

Use `Cache-Control: no-cache`. The service updates `heartbeatAt` at least every five seconds; the browser treats status as stale after 15 seconds. Status must not report an inferred queue depth.

Restrict CORS to configured application origins in deployed environments. Tile and manifest endpoints are read-only and must not accept user-controlled upstream URLs.
## Verification Boundary
The contract's `state_digest` is a streaming complete-world digest, not a Merkle root. It can verify all canonical chunks downloaded together but cannot authenticate one visualization tile independently.

Version one therefore has this explicit boundary:

- Chain RPC is authoritative for current metadata and committed events.

- The indexer verifies a complete canonical download against chain population and `state_digest` before publication.

- Before first display, the browser requires the manifest and provenance identity to match either current chain metadata or archived committed event evidence from the configured contract. `WorldInitialized` proves generation zero by definition and must match seed, population, and digest. `GenerationAdvanced` must match generation, population, and digest. Stable seed and dimensions must also match current contract metadata.

- The browser validates tile path, coordinate, content type, and byte length.

- The browser trusts the configured local indexer and publication backend for the mapping from a verified manifest to individual tile bytes.

- A manifest previously matched to chain metadata may remain displayed after the chain advances, but must be labeled historical or behind.


An indexer candidate that has not matched chain metadata or a committed event is not displayable. Keep the last verified snapshot and identify the candidate as unverified indexer data.

For the local version, the browser accepts SQLite-backed provenance as indexer-attested historical event evidence under this trust boundary. It still validates current snapshots directly against chain metadata when possible. A future devnet version must validate historical evidence through an archival chain event service or a separately specified proof mechanism.

Do not show **Cryptographically verified tile** or equivalent language. Suitable text is **Snapshot verified by indexer against the complete on-chain digest; individual tiles do not carry proofs**.

A later contract version may commit a Merkle root over canonical chunks or visualization aggregates. That change requires a versioned manifest and browser proof validation; it must not silently reinterpret the version-one digest.
## Renderer Design
### Library Decision
Use deck.gl's `OrthographicView` and `TileLayer` as the viewport and tile-lifecycle foundation. They support non-geographic coordinates, custom `getTileData` loading with `AbortSignal`, request throttling, byte-bounded caching, parent/child refinement, picking, and viewport-ready callbacks. Use the modular `@deck.gl/core`, `@deck.gl/geo-layers`, and required luma.gl packages rather than the aggregate `deck.gl` bundle.

Implement one small custom Life tile sublayer for density and bit-packed cell textures, the color shader, exact inspection, and explicit resource finalization. Use two digest-keyed `TileLayer` instances during a generation transition. A custom refinement callback must enforce this specification's one-parent fallback limit instead of accepting deck.gl's unrestricted `best-available` behavior.

deck.gl replaces custom camera gesture handling, visible-tile selection, request cancellation, and the general tile cache. It does not replace manifest validation, workers, exact decoded bytes, generation-switch policy, or transaction state. Before full implementation, prove in a focused fixture that the custom sublayer can upload the selected integer texture format, report exact picked values, release textures on tile eviction, and detect complete selected-level viewport coverage.

The fixture must also prove the non-power-of-two tile counts at every level, edge-tile bounds, orthographic world clamping, zoom hysteresis, strict one-parent refinement, aborted-load cleanup, two simultaneous digest layers, and exact selected-level coverage detection. Switch to OpenLayers `DataTileSource` plus `WebGLTileLayer` if satisfying these requirements would require replacing deck.gl's scheduler. OpenLayers also supports custom projections, typed-array tiles, nearest-neighbor sampling, and pixel data reads. TWGL alone is not sufficient because it reduces raw WebGL boilerplate but does not provide the required viewport, tile scheduling, cache, or refinement behavior.

### Ownership
React owns application chrome, durable lifecycle presentation, sheets, and discrete metadata. One imperative deck.gl instance owns WebGL resources, camera state, animation frames, tile visibility, fetch cancellation, and pointer interaction.

- Create one renderer per mounted world canvas.

- Store transient camera values outside React.

- Drive drawing through `requestAnimationFrame` only while input, animation, tile upload, or snapshot transition requires it.

- Publish throttled, discrete camera summaries to React only when labels or controls need them.

- Dispose event listeners, workers, abort controllers, textures, buffers, and animation frames on unmount.

- Handle WebGL context loss and restoration without losing durable transaction state.

### Tile Selection And Loading
- Select the nearest pyramid level from camera scale and apply hysteresis to prevent level flicker.

- Request visible tiles first, then one surrounding ring for pan prefetch.

- Cancel queued work that is no longer useful, but allow already cached immutable responses to complete when inexpensive.

- Deduplicate fetches by full immutable URL.

- Decode and unpack tiles in workers, not on the main thread.

- Set `TileLayer.maxRequests` independently from worker concurrency and pass its abort signal through every fetch and decode boundary.

- Set `maxCacheByteSize` from the configured CPU budget and ensure each tile result reports `byteLength`. Bound custom GPU textures separately and finalize them when deck.gl unloads their tile sublayers. Cache keys include state digest, level, x, and y.

- Never reuse a texture across digests without uploading the new bytes.

- Use a custom `refinementStrategy` to render lower-resolution ancestor tiles while exact selected-level tiles load without exceeding the permitted fallback distance.

### Generation Switching
When a newer manifest becomes ready:

1. Validate it independently of the currently displayed manifest.

2. Start loading the new manifest's visible selected-level tiles and required ancestors.

3. Continue rendering the previous digest without clearing the canvas.

4. At level six, switch only after level-six tiles cover the complete visible region. At levels zero through five, permit coverage from the selected level or its immediate parent only.

5. Crossfade the two complete coverages when motion is allowed; otherwise switch in one frame.

6. Release old-generation GPU resources through normal LRU pressure after the transition.


Every draw call in one snapshot layer uses one digest. A frame may contain an old and new layer during crossfade, but must never combine old and new tiles within a layer.

Pointer inspection remains pinned to the old named generation during a crossfade. It switches to the new generation only when the renderer commits new snapshot ownership, and the tooltip always states that generation.
### Shading
- Density colors derive from exact ratio using a documented monotonic ramp.

- Keep dead space visually distinct from unavailable tiles.

- At close zoom, render exact live-cell quads or texels with crisp edges.

- Show grid lines only when cells occupy enough screen pixels; fade them before they create moire.

- Use premultiplied alpha consistently.

- Test color contrast and provide a color-vision-safe default ramp.


Use WebGL2 as the required accelerated path. If unavailable, show a clear unsupported-renderer state with metadata and transaction recovery still accessible. Do not fall back to 100 million canvas draw calls or DOM elements.
## Chain Integration
### Typed Adapters
Generate bindings from the built contract specification. Do not hand-code selectors or event layouts. Provide narrow adapters for:

- `get_metadata()`

- `get_cell()` for diagnostics and tests, not routine interaction

- `get_chunk()` for indexer ingestion and explicit verification tools

- `request_tick()`

- `process_next_tick()`

- `WorldInitialized`, `TickRequested`, and `GenerationAdvanced` decoding


Adapters distinguish typed returns, typed contract errors, guest faults, transport errors, and malformed responses. Validation is event-specific: `WorldInitialized` checks contract, topic and payload shape, seed, queue capacity, population, and digest; `TickRequested` checks contract, request ID, and requester; `GenerationAdvanced` checks contract, request ID, requester, generation, population, and digest.
### Metadata Polling
- Load chain metadata and latest indexer pointer in parallel.

- Poll metadata while visible and back off after transport failures.

- Pause nonessential polling while the document is hidden.

- Refresh immediately after a committed crank and on visibility restoration.

- Store chain observations as `(generation, population, digest, block identity, source)`. Ignore lower generations, require equal-generation observations to have equal population and digest, and surface an integrity error on conflict.

- Do not infer a chain generation from indexer publication alone.

### Event Observation
- Scan all unresolved requests in one ascending query from the minimum safe block. For each record, this is its receipt block when no watermark exists, otherwise `observedThroughBlock + 1`; use the minimum across records.

- Follow cursors to exhaustion with a bounded page size.

- Deduplicate events by `(transactionHash, sequenceNumber)`.

- Reject repeated cursors rather than looping forever.

- Accept a terminal event in the admission receipt block.

- Match request completion exclusively by valid `request_id` plus contract and requester fields.

- Persist `observedThroughBlock` for each included unresolved record.

- Detect event-retention gaps and never mark affected requests failed or completed. If no retained crank receipt or archival event source can prove the outcome, present **Completion permanently unknown because event history is unavailable**.

- Apply all matching events from one receipt or scan in one locked durable-state update.

- Advance watermarks only after every page through one confirmed terminal block has completed successfully. A failed or partial paginated scan advances none of the included records.


Because an accepted request can remain queued indefinitely, deployment must provide archival lifecycle events for the contract's lifetime. If that guarantee is unavailable, the deployment must state the finite tracking window and accept that older unresolved requests become permanently unknown. There is no contract-view recovery because the contract stores no processed-request history.
## Transactions
### Write Boundary
Use a small replaceable write boundary based on the existing swap application:

```ts
interface WriteBoundary {
  execute(
    target: Invocation,
    policy: TransactionPolicy,
    observer: { onSigned(hash: string): void },
  ): Promise<WriteResult>;
  observe(hash: string): Promise<WriteResult>;
}
```

`TransactionPolicy` supplies measured outer-transaction gas, target-call gas, expiry, and observation timeout for either admission or full tick processing. Do not reuse the current generic 10,000,000 gas default for a full tick.

The boundary must:

- Wrap the target through the selected development wallet root invocation.

- Use a fresh random nonce and bounded block expiry.

- Sign canonical bytes and derive the canonical hash locally.

- Call `onSigned` before submission so the hash is durable first.

- Verify that the RPC-returned hash matches.

- Observe the original hash after an ambiguous disconnect.

- Return explicit pre-submission failure, invalid, committed success, committed failure, or indeterminate outcomes.

- Never manufacture a new automatic transaction after an ambiguous result.

### Transaction Profiles
Setup must generate measured profiles after the contract feasibility gate:

```ts
interface LifeTransactionProfiles {
  request: {
    transactionGasLimit: string;
    targetGasLimit: string;
    expiryBlocks: number;
    observationTimeoutMs: number;
  };
  crank: {
    transactionGasLimit: string;
    targetGasLimit: string;
    expiryBlocks: number;
    observationTimeoutMs: number;
  };
}
```

Request expiry must be bounded so an excluded full-queue request cannot execute unexpectedly much later. Crank expiry must be short so a losing competing crank does not execute after the user's context has changed. Crank timeout must accommodate measured full-generation execution and block inclusion. Both crank gas limits must cover their measured layer so the wallet wrapper cannot leave `process_next_tick()` at a generic inner-call default. Reject absent, zero, unsafe, or placeholder profile values at startup.
### Request Admission
Under the network/account/contract Web Lock:

1. Re-read durable request and crank state.

2. Persist a local request record in `signing` before signing.

3. Build `request_tick()` through generated bindings.

4. Persist the canonical hash synchronously in `onSigned` before submission.

5. Classify the write result.

6. On committed success, require exactly one valid `TickRequested` event for the target contract and caller.

7. Persist `request_id`, receipt block, and `accepted` before any crank record is created.


A successful receipt without a decodable matching event becomes `acceptedUntracked`, not freely retryable. Provide receipt inspection and recovery. Only the committed event proves acceptance.

An invalid or expired transaction with authoritative status may be retried as a new request. An explicit wallet rejection before `onSigned` is a retryable pre-submission failure. A hashless `signing` record restored after a crash or reload needs explicit user confirmation that signing did not complete before it can be abandoned.
### Automatic Crank
After durable acceptance, and while retaining the same lock:

1. Persist a new crank attempt before signing.

2. Build `process_next_tick()` with the measured crank profile.

3. Persist its canonical hash in `onSigned` before submission.

4. Submit exactly once.

5. Decode the typed return and zero or one `GenerationAdvanced` event from a committed successful receipt.

6. Apply the event to any matching local request by `request_id`.

7. Persist the crank outcome and release the lock.


A decoded `None` return with no `GenerationAdvanced` event means **Crank found no work** and does not alter accepted request records. A decoded `Some(TickResult)` plus exactly one matching event is a successful advance; an event for another request is still a successful crank and immediate chain metadata signal. Every other successful-return/event combination is an incompatible or indeterminate result that requires receipt inspection and must not mutate request completion.
### Manual Crank
The crank helper assumes its caller holds the scope's Web Lock. Manual processing acquires that lock before invoking the helper. It must re-read durable state after acquisition and refuse to sign while another local crank is signing or indeterminate. A retry after authoritative crank failure creates a new attempt but never resubmits a tick request.
### Outcome Rules
- Pending status is nonterminal.

- Invalid or expired status is authoritative failure.

- A committed receipt's execution result determines success or contract failure.

- Timeout, unknown status, recent conflict, and ambiguous disconnect are indeterminate.

- An indeterminate hash remains the only transaction identity until observation resolves it.

- Never retry an indeterminate transaction automatically.

- Queue exclusion and later expiry do not establish request acceptance.

- Crank success never establishes completion of a different `request_id`.

## Durable State
Use versioned, validated `localStorage` records scoped by normalized network ID, account address, and contract address. Serialize `bigint` and `u64` values as decimal strings.

Each request record includes:

```ts
interface TickRequestRecordV1 {
  schemaVersion: 1;
  localId: string;
  requester: string;
  status:
    | "signing"
    | "indeterminate"
    | "invalid"
    | "accepted"
    | "acceptedUntracked"
    | "advanced";
  transactionHash: string | null;
  requestId: string | null;
  receiptBlock: string | null;
  submittedAt: string;
  acceptedAt: string | null;
  observedThroughBlock: string | null;
  resultingGeneration: string | null;
  resultingPopulation: string | null;
  resultingStateDigest: string | null;
  advancedTransactionHash: string | null;
}
```

Crank attempts are independent records with local ID, status, canonical hash, timestamps, receipt block, consumed request ID when present, resulting generation and digest when present, and diagnostic reason. Signing and indeterminate attempts block duplicate local cranks.

- Validate all fields and lifecycle invariants on load.

- Never evict unresolved requests or unresolved crank attempts.

- Bound terminal history by count after preserving the latest meaningful activity.

- Preserve malformed storage for diagnosis and fail safely rather than overwriting it.

- Run migrations and all read-modify-write operations under the same Web Lock.

- Write a migrated representation before deleting its predecessor.

- Listen for relevant `storage` events and reload only the affected scope.

- After lock acquisition, always re-read storage before signing.

## Development Identity And Security
The local version reuses the swap application's Alice, Bob, and Carol disposable personas and selector behavior. Each immutable persona record contains its ID, label, signer material reference, wallet root address, wallet entrypoint, and expected contract caller address. Setup must verify that the wallet invocation makes `get_caller()` equal that expected caller before enabling writes.

- Keep persona selection in tab-local `sessionStorage`.

- Keep transaction records account-scoped in `localStorage`.

- Never persist private keys in browser storage.

- Inject disposable credentials only during non-preview Vite development serve when the application server, proxy, RPC, and indexer all use loopback interfaces.

- Exclude credentials from builds and previews.

- Pass the selected signing record explicitly to transaction-capable code; never add private keys to public application configuration.

- Remount account-bound readers, writers, observers, forms, and timers when the selected account changes.

- Serialize account switching against that account's Web Lock.

- Scope durable transaction records and Web Locks by normalized network, expected caller, and Life contract address.


Different personas may submit requests concurrently, and one persona may process another's request. The selector must not imply private queues or account-owned generations.

Do not add analytics or external telemetry. Never log private keys, signed transaction bytes, or complete disposable credential manifests.

When credentials are enabled, bind Vite and its proxy only to `127.0.0.1` or `::1`, reject non-loopback `Host` and `Origin` headers, and load no remote scripts. Disable credential injection if any of these conditions cannot be enforced.
## Configuration
Validate configuration once before mounting the runtime:

```text
VITE_GROUNDHOG_RPC_URL
VITE_GROUNDHOG_NETWORK_ID
VITE_GAME_OF_LIFE_CONTRACT_ADDRESS
VITE_GAME_OF_LIFE_INDEXER_URL
VITE_GAME_OF_LIFE_REQUEST_TRANSACTION_GAS_LIMIT
VITE_GAME_OF_LIFE_REQUEST_TARGET_GAS_LIMIT
VITE_GAME_OF_LIFE_REQUEST_EXPIRY_BLOCKS
VITE_GAME_OF_LIFE_REQUEST_TIMEOUT_MS
VITE_GAME_OF_LIFE_CRANK_TRANSACTION_GAS_LIMIT
VITE_GAME_OF_LIFE_CRANK_TARGET_GAS_LIMIT
VITE_GAME_OF_LIFE_CRANK_EXPIRY_BLOCKS
VITE_GAME_OF_LIFE_CRANK_TIMEOUT_MS
```

Vite receives the compact `GROUNDHOG_DEV_PERSONAS` JSON only through the existing serve-only, loopback-only credential injection boundary. Do not prefix it with `VITE_`. The active persona supplies the wallet root, wallet entrypoint, expected caller, and signer material together; public configuration must not define a competing singular wallet identity.

- Accept only HTTP(S) RPC and indexer URLs without embedded credentials.

- Accept the network ID as optional-`0x` input, then normalize it once to exactly 64 lowercase hexadecimal characters without `0x`. Require wallet, caller, contract, and digest values to be canonical lowercase 32-byte `0x`-prefixed identifiers.

- Parse gas as positive bounded integers without `number` conversion.

- Parse expiry and timeout values as safe positive integers within documented operational bounds.

- Require the application server, proxy, indexer, and RPC origins to be loopback when disposable browser credentials are enabled.

- Keep signing material outside public config.

- Scope camera preferences and durable records by normalized network and contract identity.


The local Vite proxy must remain same-origin and loopback-only, accept POST JSON only, enforce body limits, and allowlist required RPC methods for chain tip, typed views, events, submission, status, and receipts.
## Application Structure
Create the application at `apps/game-of-life` with React 19, Vite, TypeScript, Tailwind CSS 4, and the repository's shadcn configuration conventions.

Suggested boundaries:

```text
src/
├── app.tsx
├── config.ts
├── chain/
│   ├── client.ts
│   ├── game-of-life.ts
│   └── events.ts
├── indexer/
│   ├── client.ts
│   └── manifest.ts
├── renderer/
│   ├── life-tile-layer.ts
│   ├── snapshot-controller.ts
│   ├── tile-loader.ts
│   ├── tile-worker.ts
│   ├── inspection.ts
│   └── shaders.ts
├── transactions/
│   ├── records.ts
│   ├── observer.ts
│   ├── crank.ts
│   └── write-boundary.ts
└── components/
    ├── world-viewport.tsx
    ├── world-hud.tsx
    ├── generation-status.tsx
    ├── transaction-activity.tsx
    └── world-details.tsx
```

Keep pure tile coordinate, decoding, camera, and lifecycle functions separately testable. Do not split trivial presentation into a broad shared component library.

Use React state for discrete application state. Do not update React state on every pointer move, camera frame, or tile arrival. Use `startTransition` for nonurgent manifest and history presentation changes where it improves responsiveness. Avoid memoization unless profiling or stable external APIs require it.

Create the single-writer Rust indexer at `helpers/game-of-life-indexer` so it participates in the existing Cargo workspace. Keep canonical chunk, population, and digest verification shared with host-capable pure contract modules where doing so does not pull SDK storage code into the service.
## Failure States
The interface must distinguish:

- Invalid startup configuration.

- RPC unavailable or incompatible.

- Contract uninitialized.

- Unsupported contract dimensions or chunk schema.

- Indexer unavailable with a retained snapshot.

- No ready snapshot yet.

- Manifest malformed or unsupported by current metadata or retained committed-event evidence.

- Provenance missing, malformed, or inconsistent with its manifest.

- Indexer status stale or unavailable while static artifacts remain readable.

- Tile unavailable, malformed, or wrong length.

- WebGL2 unavailable or context lost.

- Request pre-submission failure, invalidity, committed contract failure, and uncertainty.

- Request accepted but not yet processed.

- Crank no-op, committed failure, exclusion, expiry, and uncertainty.

- Event history retention gap.

- Snapshot verification or publication failure.


Errors must retain useful hashes and recovery actions. Do not collapse uncertainty into failure or offer a duplicate-causing retry.
## Testing
### Pure Unit Tests
- Tile counts, spans, edge bounds, parent-child mapping, and world-to-tile coordinates at every level.

- Contract chunk reconstruction, tail trimming, LSB-first cells, and level-six tile output.

- Exact density aggregation and population preservation at every level.

- Manifest parsing, canonical identifiers, unsupported versions, and path confinement.

- Camera clamping, fit-world scale, pointer-centered zoom, and URL-state bounds.

- Transaction state transitions, retry eligibility, schema validation, and migrations.

- Event decoding, correlation, pagination, deduplication, repeated-cursor rejection, and retention gaps.

### Indexer Tests
- Complete committed storage-delta ingestion produces the same canonical bytes as chunk views.

- A delta without every value, key, metadata update, or committed block identity is rejected and falls back safely.

- Pinned coherent download publishes successfully.

- An unpinned generation change during download discards all work.

- Wrong population or digest prevents publication.

- Missing or malformed chunks prevent publication.

- Every density level sums to exact population.

- Reassembled level-six tiles reproduce canonical bytes and digest.

- Publication updates `latest.json` only after all immutable artifacts exist.

- A delayed older build cannot replace a newer latest pointer.

- Failure leaves the prior pointer unchanged.

- Repeated indexing of one digest is idempotent and byte-stable.

- Restart restores event cursors and verified evidence from SQLite without republishing different immutable bytes.

- Status and provenance schemas remain consistent with publication state.

### Renderer Tests
- Visible tile selection and ancestor fallback across viewport sizes and device pixel ratios.

- Fetch deduplication, cancellation, worker decoding, byte-length rejection, and LRU eviction.

- No texture reuse across digests.

- Old generation remains visible until new coverage is ready.

- Exact-cell zoom waits for level-six coverage; density zoom permits at most one ancestor level.

- One layer never mixes digests.

- Context loss and restoration release and recreate resources correctly.

- Reduced-motion mode skips animated transitions.


Use deterministic screenshot or pixel tests for the density ramp, close cell view, missing-tile state, and old-to-new snapshot transition. Keep shader logic small enough to compare against a CPU reference.
### Component Tests
- Chain, preparing, and visualized generations remain distinct.

- Mobile and desktop controls expose the same required actions and status.

- Exact-cell and aggregate-density inspection use correct language.

- Automatic mode submits request then one crank in order.

- Manual mode skips automatic crank and exposes explicit processing.

- Mount, mode change, recovery, and indexer publication never initiate writes.

- Crank events for another request do not complete the user's request.

- Mismatched `process_next_tick()` return and event combinations require inspection and do not report an empty queue.

- A manifest without matching chain metadata or committed-event evidence is never displayed.

- Missing or stale status degrades preparation messaging without invalidating already verified static artifacts.

- Meaningful lifecycle changes are announced once; polling and camera movement are silent.

- Unsupported WebGL leaves transaction recovery accessible.

### Local Integration Tests
Run mode-gated tests against a compatible local node and indexer:

1. Load metadata and a verified generation-zero manifest.

2. Submit request only and recover its accepted record from a committed event.

3. Run automatic request plus exactly one crank and observe the resulting generation.

4. Have another persona's crank consume the first persona's request and reconcile it after account switching.

5. Submit concurrent persona requests and verify distinct IDs without queue-position assumptions.

6. Reload during indeterminate request and crank outcomes and recover by original hash.

7. Exercise paginated event recovery and cross-tab write serialization.

8. Ingest one full generation from committed storage delta and prove it matches the canonical digest.

9. Force the view fallback, advance the chain during download, and prove that no mixed snapshot publishes.

10. Restart the indexer and recover its event cursor, generation evidence, and latest publication.

11. Keep generation N visible until generation N+1's viewport coverage is ready.

12. Download and verify one complete canonical generation against contract metadata.


Keep the full 100-million-cell crank and complete index build behind an explicit long-running acceptance command. Record wall-clock time, tile build time, generated bytes, first-ready-manifest latency, and visible-tile load latency.
## Performance Budgets
Use these version-one defaults, then lower them if measurements show that supported devices need stricter limits:

- No routine browser path downloads all canonical chunks or the complete tile pyramid.

- Initial rendering requests only the manifest, selected-level visible tiles, immediate ancestors, and one prefetch ring.

- Camera interaction does not cause per-frame React renders.

- Tile decoding and bit unpacking stay off the main thread.

- Browser tile fetching uses at most eight concurrent requests and tile decoding uses at most two workers.

- Decoded CPU tile bytes and GPU textures each use an LRU budget no greater than 64 MiB by default.

- On reference hardware, p95 interaction frames remain below 16.7 ms on desktop and 33.3 ms on a mid-range mobile device while metadata polling continues.

- View-fallback indexing uses at most 32 concurrent chunk reads by default and separately bounded tile-build and filesystem-write queues.

- Exact-cell generation switching waits for complete visible level-six coverage; density switching waits for selected-level or immediate-parent coverage.


Before release, name the reference devices and publish measured first content, interaction frame time, peak browser memory, visible-generation switch latency, and index build duration. Any changed limits become explicit configuration with validated upper bounds.
## Acceptance Criteria
- The complete world is navigable without per-cell DOM or routine full-world downloads.

- Close zoom shows exact canonical cell state; lower zoom shows exact aggregate counts.

- The indexer publishes only complete snapshots that match chain population and digest.

- The indexer prefers complete committed-delta ingestion, rejects incomplete delta sources, and retains the verified view fallback.

- Local publication is single-writer, crash-safe, and restartable from SQLite evidence plus immutable filesystem artifacts.

- The browser displays a snapshot only after its identity matches chain metadata or a retained committed event.

- Immutable paths include network, contract, and complete state digest.

- The browser never displays mixed-generation tiles in one snapshot layer.

- The previous generation remains visible until the new visible region is ready.

- Chain, preparing, and visualized generations are independently represented.

- Request admission and crank remain two transactions.

- Only committed `TickRequested` establishes acceptance.

- One automatic admission initiates at most one crank and recovery never initiates one.

- Request completion is correlated only through `request_id`.

- The UI makes no queue-position, queue-depth, latency, or crank-ownership promise.

- Signed hashes and unresolved lifecycle state survive reloads and cross-tab activity.

- Indeterminate transactions are never retried automatically.

- Measured outer-transaction and target-call gas limits both reach the full crank invocation.

- The supported event source retains request lifecycle events for the contract's lifetime, or the deployment documents its finite window and permanent-unknown limitation.

- The verification boundary states that individual tiles lack cryptographic proofs.

- Mobile, tablet, desktop, keyboard, reduced-motion, and WebGL failure paths are tested.

- A full-scale local acceptance run demonstrates request, atomic crank, indexing, and generation switch end to end.

## Implementation Order
1. Complete the contract's transaction harness, canonical vectors, preliminary storage fixture, and production-shaped feasibility gate; generate bindings and provide an initialized local deployment.

2. Probe committed transaction details, storage deltas, block-pinned reads, event pagination, finality, and `get_chunk()` return limits against the target local node.

3. Run the expanded deck.gl compatibility fixture in parallel with the RPC probes.

4. Build typed metadata, event, request, and crank adapters.

5. Implement the single-writer indexer, preferred committed-delta ingestion, verified view fallback, SQLite evidence, deterministic tile derivation, filesystem publication, and status API.

6. Implement manifest and provenance validation, tile coordinate utilities, workers, and bounded caches.

7. Build the deck.gl renderer with one static generation.

8. Add React shell, responsive controls, metadata, and generation distinction.

9. Port write-boundary, persona, persistence, Web Lock, observation, and recovery patterns from the swap app.

10. Add automatic request-plus-one-crank and advanced manual mode.

11. Add generation switching, ancestor fallback, and reduced-motion behavior.

12. Run focused unit, component, renderer, indexer, and local integration tests.

13. Run and document the full 100-million-cell end-to-end benchmark.

## Open Questions
- What measured gas, expiry heights, and observation timeouts should setup generate for request and crank profiles?

- Does the committed transaction or development-detail API expose all destination storage values and metadata needed for primary indexer ingestion?

- Can the deployed RPC pin batch or `get_chunk()` views to one block, or must the local fallback rely on a quiet window plus before-and-after metadata and digest rejection?

- What archival event and artifact-storage services should replace local SQLite and filesystem publication for a later devnet deployment?

- How many historical digest snapshots should the indexer retain?

- What browser CPU-byte and GPU-texture cache limits fit the supported demo devices?

- Does the default density ramp need a logarithmic display option for sparse later generations?

- Should a future contract version replace or augment the streaming digest with a Merkle root for browser-verifiable tiles?

---
comments:
  c1:
    body: love it! i wonder if there are any webgl libraries or helpers or open
      source components we could leverage here.
    by: user
    at: 2026-08-28T02:16:05.548Z
  c2:
    body: >-
      Yes. I recommend deck.gl's OrthographicView and TileLayer. They cover the
      non-geographic camera, visible-tile scheduling, abortable custom loads,
      byte-bounded caching, refinement, picking, and React integration. We keep
      a small custom Life sublayer for integer textures, shaders, exact
      inspection, and digest-atomic switching. I added this decision and a
      proof-of-concept gate to the renderer section. OpenLayers is the fallback;
      TWGL is too low-level to remove the hard tile-lifecycle work.
    by: OpenCode
    at: 2026-08-27T22:16:55-04:00
    re: c1
