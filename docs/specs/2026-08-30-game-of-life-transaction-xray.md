# Game of Life Transaction X-Ray

Status: Draft

Date: 2026-08-30

## 1. Executive Summary

### Problem Statement

The Game of Life explorer proves that a 10,000 by 10,000 world exists and advances, but its full-screen map does not explain how one transaction can read, compute, and atomically commit the next state of 100 million persistent cells. Visitors cannot inspect the storage layout, follow a cell through that layout, distinguish fixed workload facts from observed execution evidence, or understand where the chain, indexer, and browser each participate.

### Proposed Solution

Add an interactive Transaction X-Ray at `/xray`. The page presents the same workload at progressively larger scales, from one cell to a committed block, and ties each claim to its source. It combines a fixed storage atlas, an exact cell-to-storage microscope, a transaction anatomy, a proof pipeline, and live metadata and provenance from the existing chain and indexer clients.

The page supports this precise claim:

> One Groundhog contract invocation reads, computes, and commits the exact next state of a persistent 100-million-cell Conway world atomically.

The page must not imply that the browser or indexer computes canonical state. It must not present configured gas limits as gas consumed, estimates as measurements, or broad cross-chain claims without directly comparable evidence.

### Success Criteria

- A visitor can identify the canonical world size, encoding, row size, chunk split, bank size, and per-tick read and write counts without consulting source code.
- A visitor can enter any valid `(x, y)` coordinate and see the exact byte, bit, part, chunk key, and bank mapping using the contract's canonical formulas.
- Every dynamic value identifies its source as chain metadata, indexer-attested provenance, receipt measurement, benchmark measurement, indexer measurement, configuration, or illustration.
- The interface remains complete and usable at 320 CSS pixels wide, with keyboard-only navigation, 200% browser zoom, and reduced motion enabled.
- The page passes the repository's typecheck, formatting, unit/component tests, Chromium end-to-end tests, and production build.
- The initial page does not download canonical bank contents or visualization tiles unless a later interaction explicitly requires them.

## 2. User Experience and Functionality

### User Personas

- **Technical evaluator:** wants to determine what the demonstration proves and which claims are measured.
- **Smart-contract engineer:** wants to inspect encoding, storage keys, streaming reads, writes, and atomic commit behavior.
- **Curious visitor:** wants a clear visual explanation of the scale without reading the contract.
- **Groundhog contributor:** wants live transaction and provenance identifiers that connect the visualization to local node evidence.

### Core Narrative

The page follows one continuous scale ladder:

```text
cell -> bit -> byte -> chunk -> row -> bank -> transaction -> block
```

Each step answers one question:

| Scale       | Question                        | Exact fact                                                                      |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------- |
| Cell        | What changes?                   | One binary Conway cell                                                          |
| Bit         | How is it encoded?              | One LSB-first bit                                                               |
| Byte        | What shares storage?            | Eight horizontal cells                                                          |
| Chunk       | What can one bytestring hold?   | 1,000-byte head or 250-byte tail                                                |
| Row         | How is a world row represented? | 1,250 bytes for 10,000 cells                                                    |
| Bank        | How is one generation stored?   | 20,000 chunks totaling 12,500,000 bytes                                         |
| Transaction | What does one tick touch?       | 20,004 bank-chunk reads, 20,000 bank-chunk writes, 100,000,000 rule evaluations |
| Block       | What makes it canonical?        | One successful invocation includes the complete bank switch and metadata update |

The narrative has two reading modes without a mode switch:

- The primary layer uses short statements, large exact values, and direct manipulation.
- Expandable evidence details expose formulas, identifiers, provenance, and technical qualifications.

### Information Architecture

The page contains these ordered regions:

1. **Site header:** shared product identity, current network state, and links between World and X-Ray.
2. **Hero instrument:** the demonstration claim, current generation when available, and an animated but non-authoritative transaction trace.
3. **Storage Atlas:** two-bank topology, row and chunk counts, current/next bank roles, and scale controls.
4. **Cell Microscope:** exact coordinate-to-storage mapping and an eight-bit byte view.
5. **Atomic Transaction Anatomy:** ordered read, compute, write, metadata, event, and commit stages.
6. **Compute Lens:** fixed logical workload facts alongside optional receipt-measured facts.
7. **Proof Pipeline:** chain, indexer, and browser responsibilities with live provenance.
8. **Comparison Framework:** qualified questions for evaluating the same workload elsewhere.
9. **Evidence footer:** contract, network, source block, transaction, digest, and source links when available.

The document order must remain meaningful without CSS or JavaScript animation.

### Visual Direction

The page should resemble a precise hardware diagnostic instrument rather than a generic analytics dashboard.

- Continue the explorer's near-black palette and bright cellular signal color.
- Introduce a warm amber evidence color for storage addresses and a cool blue for provenance paths.
- Use a restrained technical display face for metrics and the existing readable sans-serif for prose.
- Use rules, tracks, ticks, bit fields, and connected stages instead of repeated interchangeable cards.
- Keep the visual density high on desktop while preserving a clear left-to-right or top-to-bottom reading order.
- Use one coherent animated signal that moves through the transaction path. Do not add decorative particles.
- Never animate cells through invented intermediate states. A generation transition is atomic.
- Respect `prefers-reduced-motion` by removing sweeps, counters, and path motion while preserving all final states.

### User Stories and Acceptance Criteria

#### Story 1: Understand the Scale

As a visitor, I want to move from one cell to the full transaction so that I can understand the workload without first understanding the code.

Acceptance criteria:

- The scale ladder exposes all eight levels in order.
- Selecting a level updates the focused explanation and corresponding atlas emphasis.
- The content remains understandable if animation is disabled.
- The page states both `100,000,000 cells` and `12,500,000 bytes per generation`.
- Large values include exact decimal forms; abbreviated forms may supplement but never replace them.

#### Story 2: Inspect a Cell's Storage Address

As an engineer, I want to enter a coordinate so that I can verify its exact contract storage location.

Acceptance criteria:

- Inputs accept integers from `0` through `9,999` for both axes.
- Invalid, empty, fractional, or out-of-range values do not update the active coordinate and produce an inline validation message.
- For active coordinate `(x, y)`, the interface displays:

```text
byte_in_row = floor(x / 8)
bit         = x % 8
part        = byte_in_row < 1000 ? 0 : 1
byte_in_part = part == 0 ? byte_in_row : byte_in_row - 1000
chunk_key   = y * 2 + part
```

- The bit view shows eight horizontal cell positions and identifies the selected bit under LSB-first numbering.
- The selected row and chunk are highlighted in the Storage Atlas.
- The active bank is derived from validated chain generation parity and labeled **Contract-derived**. If validated generation is unavailable, the page labels the bank as unknown rather than guessing.
- Copy actions, if present, copy plain exact values and provide a non-color success indication.
- A shareable X-Ray location uses namespaced query parameters `cellX` and `cellY`; it does not reuse the world camera's `x`, `y`, or `z` keys.

#### Story 3: Follow One Atomic Tick

As a technical evaluator, I want to follow the complete tick path so that I know which work happens inside one invocation.

Acceptance criteria:

- The transaction anatomy contains these ordered stages:
  1. Read and validate world metadata.
  2. Consume one queued request.
  3. Stream the active bank and evaluate Conway's rule for all 100 million cells.
  4. Write every row to the inactive bank.
  5. Update generation, the internal `WorldState.active_bank`, population, and state digest exclusively. The UI derives the resulting bank role from generation parity because the public metadata view omits `active_bank`.
  6. Release one queue-capacity slot and emit `GenerationAdvanced`.
  7. Include all changes in the committed block or revert all changes.
- The page states that the invocation treats the active bank as immutable input while writing the inactive bank. External observers see only the canonical pre-commit or post-commit state.
- The page states that a failed invocation commits neither a partial bank nor partial metadata.
- The page does not imply eight independent VM operations per cell; `100,000,000 rule evaluations` describes logical cell outcomes.
- The visual trace is explicitly labeled as an explanation, not a live execution timeline.

#### Story 4: Distinguish Fixed Facts from Measurements

As an evaluator, I want each number labeled by evidence type so that I do not mistake configuration or illustration for measured execution.

Acceptance criteria:

- Every workload metric has exactly one of these source labels:
  - **Contract-derived:** fixed by constants, encoding, or algorithm.
  - **Chain metadata:** returned by the current contract view.
  - **Indexer-attested provenance:** the indexer's validated record of a committed event or metadata observation.
  - **Receipt-measured:** decoded directly from a committed transaction receipt.
  - **Benchmark-measured:** recorded by a versioned benchmark artifact with its environment and method.
  - **Indexer-measured:** observed while creating verified derived artifacts.
  - **Configured limit:** a supplied budget, not consumption.
  - **Illustrative:** explanatory motion or relative scale without measured timing.
- Configured gas values are never labeled `gas used`, `cost`, or `consumed`.
- If no receipt measurement is available, the field says `Not available` and explains where the value would come from.
- Derived arithmetic exposes its formula in an evidence detail.
- Tooltips are supplementary; all qualifications are reachable by keyboard and available in visible or expandable text.
- Provenance kind is separate from source. It uses the schema values `metadata-observation`, `world-initialized-event`, and `generation-advanced-event` and never replaces the **Indexer-attested provenance** source label.

#### Story 5: Verify a Displayed Generation

As a contributor, I want to connect the visualized generation to chain and indexer evidence so that I can inspect the trust boundary.

Acceptance criteria:

- Chain metadata and the latest immutable snapshot load independently.
- The page shows chain generation, visualized generation, population, and digest as separate fields.
- Provenance shows source block height, source block hash, evidence kind, transaction hash, request ID, requester, and verification time when present.
- A transaction hash is required for `world-initialized-event` and `generation-advanced-event` provenance. It may be absent only for `metadata-observation` provenance and is labeled accordingly.
- The proof pipeline states:
  - The chain owns canonical banks, metadata, queue semantics, digest, and atomic transition.
  - The indexer downloads committed chunks, verifies the canonical digest, and creates immutable visualization tiles.
  - The browser validates manifest/provenance agreement and displays derived artifacts.
- The page does not claim individual tile proofs; it states that canonical download verification exists and individual tile proofs do not.
- If chain and snapshot identities differ, both remain visible and the page applies the deterministic relationship rules under **Evidence Reconciliation** without blending them.
- Indexer failure does not erase chain metadata. Chain failure does not relabel indexed data as current chain state.

#### Story 6: Compare the Workload Honestly

As an evaluator, I want a reusable comparison framework so that I can assess other systems against the same requirements.

Acceptance criteria:

- The comparison section frames requirements as questions, not unsupported rankings.
- It asks whether a system can hold 100 million persistent canonical bits, read 12.5 MB, write 12.5 MB, evaluate every cell, and atomically commit the result in one invocation.
- It separately asks about transaction admission, execution, state-delta limits, block production, finality, and data availability.
- Groundhog is described by the demonstrated implementation and available evidence only.
- Other chains are not assigned pass/fail values without cited, reproducible measurements using the same workload and atomicity definition.
- The page avoids `only`, `first`, `impossible elsewhere`, and equivalent exclusivity claims unless independently substantiated later.

### States and Failure Handling

The live evidence region supports these independent states:

| Source       | States                                                                                                     | Required presentation                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Chain        | loading, ready, unavailable, malformed                                                                     | Preserve indexed evidence; never invent active bank or current generation                       |
| Snapshot     | loading, ready, unavailable, malformed, incompatible                                                       | Preserve chain evidence; identify indexed generation only when validated                        |
| Provenance   | `metadata-observation`, `world-initialized-event`, `generation-advanced-event`                             | Show only schema-permitted fields; the two event kinds form the derived `event-backed` category |
| Relationship | no live evidence, chain only, aligned, indexer behind, snapshot retained, incompatible, integrity conflict | State available identities and the reason they are or are not merged                            |

Initial loading uses stable skeleton geometry and visible labels. Loading indicators must not cause section reflow when values arrive.

Errors use concise, actionable language. Raw internal errors may appear in an expandable technical detail but not replace the user-facing explanation.

### Non-Goals

- Reimplementing the world explorer or rendering the complete generation on the X-Ray page.
- Downloading all canonical chunks, all exact-cell tiles, or the complete visualization pyramid.
- Computing or predicting a canonical next generation in the browser or indexer.
- Submitting requests or cranking the queue from the X-Ray page in the first version.
- Editing cells, changing rules, selecting a seed, or resetting the world.
- Building a general-purpose block explorer, trace debugger, or receipt archive.
- Adding individual chunk or tile cryptographic proofs.
- Estimating unmeasured gas consumption or execution duration.
- Claiming queue position, queue depth, fairness, or processing latency.
- Adding a client-side router dependency solely for two static paths.
- Publishing cross-chain benchmark rankings without reproducible equivalent workloads.

## 3. AI System Requirements

No AI model, inference service, generated explanation, or probabilistic classification participates in this feature. All displayed facts come from deterministic formulas, validated application configuration, contract metadata, indexer schemas, indexer-attested provenance, or explicitly versioned benchmark evidence.

## 4. Technical Specifications

### Authoritative Workload Model

Implement one pure TypeScript module as the source for fixed X-Ray calculations and labels. Components must not repeat workload arithmetic.

```text
WORLD_WIDTH              = 10,000 cells
WORLD_HEIGHT             = 10,000 cells
CELL_COUNT               = 100,000,000 cells
BITS_PER_BYTE            = 8
ROW_BYTES                = 1,250 bytes
CHUNK_BYTES              = 1,000 bytes
TAIL_BYTES               = 250 bytes
CHUNKS_PER_ROW           = 2
CHUNKS_PER_BANK          = 20,000
BANK_BYTES               = 12,500,000 bytes
PERSISTENT_BANKS         = 2
STEADY_STATE_BANK_BYTES  = 25,000,000 bytes
TICK_BANK_CHUNK_READS    = 20,004
TICK_BANK_CHUNK_WRITES   = 20,000
RULE_EVALUATIONS         = 100,000,000
```

`25,000,000 bytes` describes raw bank payload only. It excludes map keys, metadata, queue storage, serialization overhead, and node storage overhead. The UI may supplement it with `25 MB` using decimal units, but it must preserve the exact byte value.

The `20,004` canonical bank-chunk reads derive from a three-row toroidal stream:

```text
initial rows: 3 rows * 2 chunks = 6 reads
remaining rows: 9,999 rows * 2 chunks = 19,998 reads
total: 6 + 19,998 = 20,004 reads
```

The implementation may expose this derivation in a detail panel. It must not simplify the value to `20,000`. These counts cover canonical bank bytestring I/O, not all storage or runtime activity. Metadata reads and writes, queue consumption, slot release, map-key access, event encoding, and runtime bookkeeping are additional and are not quantified by these constants.

The coordinate mapper accepts integers only and returns an immutable result:

```ts
interface CellStorageAddress {
  x: number;
  y: number;
  byteInRow: number;
  bit: number;
  part: 0 | 1;
  byteInPart: number;
  chunkKey: number;
}
```

The module rejects coordinates outside `[0, 9,999]`. Tests cover all boundaries around byte and chunk transitions, especially `x=7/8`, `x=7,999/8,000`, `x=9,999`, and `y=0/9,999`.

### Architecture Overview

The feature stays inside `apps/game-of-life` and reuses existing boundaries:

```text
window.location.pathname
  -> route-specific bootstrap
      -> /       -> persona parsing -> existing ConfiguredApp -> World App
      -> /xray   -> read-only Transaction X-Ray

X-Ray
  -> pure workload model
  -> existing read-only Groundhog client -> get_metadata()
  -> existing IndexerClient
       -> latest.json
       -> immutable manifest.json
       -> provenance.json
```

Do not add React Router. The startup entry selects a route from the normalized pathname before parsing development personas because this application has two top-level pages and does not require nested routes, route loaders, or client-side navigation state. Ordinary anchor navigation is acceptable and preserves browser semantics.

Accepted paths:

- `/` renders the existing world explorer.
- `/xray` and `/xray/` render Transaction X-Ray.
- Other paths render a compact not-found page with links to World and X-Ray.

The local Vite development, preview, and fixture servers must fall back from `/xray` to `/index.html`. Production hosting is outside this local-development version. Any later production deployment must provide the same rewrite before `/xray` is releasable.

### Component Boundaries

Prefer a small number of cohesive components over one component per metric. The expected boundaries are:

- `XrayPage`: page composition and live evidence orchestration.
- `XrayHeader`: product identity, route navigation, and source health.
- `ScaleLadder`: selected scale and concise explanation.
- `StorageAtlas`: bank, row, and chunk topology with selected-address highlighting.
- `CellMicroscope`: coordinate controls, formulas, and byte/bit representation.
- `TransactionAnatomy`: semantic ordered stages and explanatory trace.
- `EvidencePipeline`: chain/indexer/browser responsibilities and provenance.
- `ComparisonFramework`: qualified evaluation questions.

The exact file split may be smaller where a component is not reused or independently complex. Keep fixed calculations in the workload model and source-state transitions in a dedicated hook or reducer rather than in presentation components.

### Live Evidence Model

Use the existing `createLifeReadAdapter` and `IndexerClient`. Do not duplicate schema parsing or relax validation for the X-Ray page.

The X-Ray source model should contain independent chain and indexer results:

```ts
interface XrayEvidenceState {
  chain: Loadable<ChainMetadata>;
  snapshot: Loadable<ImmutableSnapshot>;
}
```

`Loadable<T>` should preserve the last valid value during a refresh failure when practical. It must distinguish initial loading from stale-but-usable evidence.

Polling requirements:

- Use the existing visibility-aware poller.
- Poll chain metadata no more often than every 15 seconds.
- Poll the indexer pointer no more often than every 5 seconds.
- Abort indexer fetches on disposal and suppress late chain metadata results after disposal. The current metadata API does not physically cancel an RPC request.
- Do not announce routine polling or unchanged data.
- Expose a manual retry when initial evidence cannot load.
- Keep fixed educational content fully usable without chain or indexer access.

The X-Ray page is read-only. Route selection must occur before development-persona parsing. The X-Ray bootstrap must not initialize personas, acquire transaction locks, access private wallet material, or construct transaction clients. Load the world application through a route-specific dynamic import so `/xray` does not evaluate its WebGL and transaction dependency graph.

### Active Bank Derivation

Current metadata exposes generation but not `active_bank`. The contract defines generation zero in bank A and flips banks once per successful generation. The page may derive the current bank as:

```text
active_bank = generation % 2 == 0 ? A : B
inactive_bank = generation % 2 == 0 ? B : A
```

This value must be labeled **Contract-derived from generation parity**, not directly returned metadata. The derivation is valid for the pinned Game of Life contract semantics. Missing or invalid metadata produces unknown bank roles; the application cannot detect a semantics change from metadata alone.

### Evidence Reconciliation

`IndexerClient.snapshotFromPointer()` first validates latest-pointer, manifest, and provenance agreement and confines all resources to the configured world. Preserve validation rejection as an incompatible result rather than collapsing it into ordinary unavailability. Apply these predicates in table order. Call `assertSnapshotEligible()` only when both valid chain metadata and a valid snapshot exist.

| Predicate                                                                               | Relationship       | Presentation                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| Snapshot rejected for invalid scope or latest/manifest/provenance disagreement          | Incompatible       | Reject the snapshot, preserve any chain evidence, and identify the validation failure         |
| No valid chain metadata and no valid snapshot                                           | No live evidence   | Keep fixed educational content usable and show both source failures independently             |
| Valid chain metadata; no valid snapshot                                                 | Chain only         | Show current chain identity and explain that no validated visualization evidence is available |
| No valid chain metadata; valid snapshot                                                 | Snapshot retained  | Show indexed identity as retained evidence; do not call it current                            |
| Same generation, seed, dimensions, population, and digest                               | Aligned            | Mark chain and snapshot identities aligned                                                    |
| Seed or dimensions differ at any generation                                             | Integrity conflict | Treat snapshot as ineligible and preserve both conflicting identities in evidence detail      |
| Snapshot generation is lower, seed and dimensions match, and provenance is event-backed | Indexer behind     | Show both generations; snapshot remains eligible historical evidence                          |
| Snapshot generation is lower and provenance is `metadata-observation`                   | Integrity conflict | Snapshot is not eligible historical evidence; show its identity only in error detail          |
| Snapshot generation is higher than chain                                                | Integrity conflict | Treat snapshot as ineligible and preserve chain evidence                                      |
| Same generation with a population or digest mismatch                                    | Integrity conflict | Treat snapshot as ineligible and preserve both conflicting identities in evidence detail      |

Source availability has precedence over relationship wording: an unavailable source retains its last valid value as stale evidence when one exists; otherwise it remains unavailable. Last valid values may participate in the comparison, but the relationship receives the visible prefix `Last observed` and cannot be presented as current. Never convert unavailability into an integrity conflict.

### Headline Evidence Bundle

The headline claim combines implementation facts and observed provenance; no single metric proves every clause. The evidence detail must provide:

- Configured network and contract identifiers.
- A repository link or revision label for the pinned Game of Life contract implementation and `process_next_tick()` entry point.
- Contract-derived world dimensions, encoding, complete-bank I/O counts, logical rule evaluations, metadata update, event name, and revert semantics.
- The latest validated snapshot's source block and indexer-attested transaction/event provenance when event-backed evidence exists.
- An explicit label when only metadata-observation provenance exists; in that state, do not present a transaction hash as observed evidence.
- A statement that X-Ray validates artifact schema and identity agreement but does not directly re-query and validate the historical chain event.
- A visible deployment assumption: application configuration identifies the address deployed by this repository's setup process, but the available metadata API does not cryptographically bind that address to the displayed source revision. Derivations describe the pinned implementation and must not be labeled as verified deployed bytecode.

### Storage Atlas Rendering

Do not create one DOM node per row, chunk, byte, bit, or cell at world scale.

The atlas should use a bounded SVG, canvas, or CSS pattern with a constant number of elements. It represents each bank as a folded 100 by 100 field where one atlas unit corresponds to one canonical row. This preserves all 10,000 rows while keeping rendering cost constant.

- Bank labels show A/B, active/inactive role, `20,000 chunks`, and `12,500,000 bytes`.
- A selected `y` highlights one of 10,000 rows and the selected `part` highlights its head or tail chunk.
- Pointer selection may update `y`, but equivalent range, number, or keyboard controls must exist.
- The representation must state that its two-dimensional fold is a visualization of row order, not the world's cell geometry.
- Animation may show a sweep from read bank to write bank, but timing is illustrative unless driven by measured receipt data.

### Transaction Anatomy

Use semantic ordered markup. Each stage exposes:

- Stage name.
- Input and output.
- Fixed work count where available.
- Authority boundary.
- Failure consequence.
- Evidence type.

The atomicity presentation must group all contract stages inside one transaction boundary. The block sits outside that boundary as the inclusion and commit container. The local demonstration treats committed blocks as final under the compatibility assumption documented by the frontend specification; X-Ray does not independently establish network finality. A revert path returns to the pre-transaction state and does not visually leave a partly written canonical generation.

The queue insertion and generation processing are separate transactions. The X-Ray page focuses on `process_next_tick()`, but it must explain that a prior commuting `request_tick()` adds intent and that the crank consumes one queued request. It must not imply that one user's crank necessarily processes that user's request.

### Compute Lens

The fixed section always shows:

- `100,000,000` logical cell-rule evaluations.
- `20,004` canonical bank-chunk reads totaling `12,502,500` bytes.
- `20,000` canonical bank-chunk writes totaling `12,500,000` bytes.
- Three source-row buffers plus one destination-row buffer, a 5,000-byte visible core row working set. SDK temporaries may raise actual peak memory.
- One population count and one streaming digest for the resulting generation.

The read-byte total includes the initial repeated toroidal rows used to seed the stream. It is larger than one bank by `2,500` bytes.

Optional measured evidence may come from a versioned repository benchmark artifact or a committed receipt available through an existing client API. Receipt fields use **Receipt-measured**; artifact observations use **Benchmark-measured** and identify their environment and method. Until such a typed source exists, the product must display `Receipt measurement not connected` rather than parse prose, scrape debug output, or infer usage from configured limits.

### Proof Pipeline

The proof pipeline uses three explicit zones:

#### Chain

- Stores canonical bank chunks and metadata.
- Serializes generation changes through exclusive metadata update semantics.
- Computes population and digest while writing the next bank.
- Emits `GenerationAdvanced` when a successful invocation commits; X-Ray receives historical event provenance through the indexer rather than directly validating the event query.
- Reverts writes and events when invocation execution fails.

#### Indexer

- Observes chain metadata and archival events.
- Downloads all canonical chunks for a generation.
- Recomputes and validates the canonical digest.
- Produces exact derived density and cell tiles.
- Publishes immutable manifest and provenance files before advancing `latest.json`.
- Never computes canonical next-state cells.

#### Browser

- Validates schema, configured scope, identity agreement, and snapshot eligibility.
- Downloads only the artifacts needed for the current view.
- Displays fixed formulas and source-qualified live evidence.
- Does not independently prove each tile against a Merkle root in version one.

### URL and Navigation Behavior

- Add a visible `Transaction X-Ray` link to the existing world header.
- Add a visible `Explore world` link to the X-Ray header.
- Use real `<a href>` links so open-in-new-tab, copy-link, browser history, and no-JavaScript path semantics remain standard.
- X-Ray coordinate state uses `cellX` and `cellY` query keys.
- The default selection is coordinate `(5,000, 5,000)` at the `cell` scale.
- A URL coordinate is valid only when `cellX` and `cellY` each occur exactly once and each value matches canonical unsigned decimal syntax with no sign, whitespace, leading zero except `0`, fraction, or exponent, and falls in `[0, 9,999]`. If either key is absent or invalid, use the complete default coordinate and do not throw.
- Committing the coordinate form updates the URL immediately with `history.replaceState`. Pointer or range interaction updates it on pointer release or keyboard change; it must not append one history entry per intermediate value.
- Do not mutate or remove unrelated query parameters.

### Responsive Behavior

#### Desktop, 1,024 CSS Pixels and Wider

- Use a wide editorial grid with a persistent scale rail where viewport height permits.
- Pair the Storage Atlas with focused scale details.
- Pair Cell Microscope formulas with the bit representation.
- Keep evidence values aligned without forcing prose into narrow columns.

#### Tablet, 600 to 1,023 CSS Pixels

- Collapse the scale rail into a horizontally scrollable, keyboard-operable control.
- Stack visual and explanatory halves when either would fall below a readable width.
- Preserve full exact values using wrapping or scrollable code rows rather than clipping.

#### Mobile, 320 to 599 CSS Pixels

- Use one content column.
- Make coordinate controls and primary scale controls at least 48 by 48 CSS pixels.
- Allow bit, formula, and provenance rows to scroll within labeled regions when they cannot wrap safely.
- Avoid fixed-position content except a compact optional return control that respects safe-area insets.
- Keep section headings, evidence labels, and exact values visible without horizontal page scrolling.

The layout must also remain usable in landscape mobile orientation and at 200% browser zoom.

### Accessibility

- Use one `h1` and a logical heading hierarchy.
- Provide a skip link to the X-Ray content.
- Use semantic navigation, ordered lists, figures, tables, forms, and disclosure elements where appropriate.
- Keep all controls keyboard operable with visible focus.
- Associate coordinate errors and help text with their inputs using `aria-describedby`.
- Represent the eight-bit byte with text or accessible labels in addition to color.
- Do not rely on hover for evidence labels or qualifications.
- Maintain at least WCAG 2.2 AA contrast for text, controls, focus indicators, and meaningful diagram edges.
- Use text and shape, not color alone, for source health, bank role, selected state, and failure state.
- Mark decorative traces and grid textures as hidden from assistive technology.
- Announce only user-requested coordinate changes, manual retries, and meaningful source-state changes in a polite live region.
- Disable nonessential motion under `prefers-reduced-motion`.
- Avoid auto-advancing carousels, typewriter effects, count-up delays, or content that appears only after animation completes.

### Performance Requirements

- The page must render a bounded number of DOM and SVG nodes independent of the 100-million-cell world size.
- Fixed content appears before live evidence completes.
- Initial page load performs at most one chain metadata request and one latest-snapshot request sequence before pollers settle.
- The first route load does not request tile binaries or canonical chunk bytes.
- Coordinate mapping performs constant-time integer arithmetic and commits one React state update per form submission, keyboard change, or animation frame of pointer interaction. End-to-end tests assert the final mapping rather than a hardware-dependent frame-time threshold.
- Pointer-driven atlas updates use at most one state commit per animation frame.
- Do not import Deck.gl, WebGL renderer modules, transaction signing code, or wallet adapters into the `/xray` route dependency graph. Use route-specific dynamic imports and verify production chunk boundaries in Phase 5.
- Decorative motion uses transforms or opacity and does not trigger continuous layout.
- No interval or animation frame remains active after unmount.

### Security and Privacy

- Treat chain, indexer, URL, and environment data as untrusted until parsed by existing validators.
- Render hashes, addresses, and errors as text; never inject HTML.
- Confine indexer resources through `IndexerClient`; do not fetch arbitrary URLs from manifest content.
- Do not place wallet secrets, development persona secrets, or signed transaction payloads in the X-Ray state, DOM, URL, logs, or analytics.
- Do not add third-party analytics, fonts, embeds, or runtime dependencies for this feature.
- External source links, if introduced, must use configured or repository-owned origins and safe `rel` attributes.

### Testing Strategy

#### Unit Tests

- Verify every workload constant and arithmetic relationship.
- Verify coordinate mapping at world, byte, and chunk boundaries.
- Verify parity-based bank derivation for generation zero, odd, even, and large decimal generations without lossy number conversion.
- Verify evidence labels and comparison-language guardrails.
- Verify query parsing for valid, missing, partial, malformed, duplicated, fractional, signed, whitespace-padded, leading-zero, and out-of-range values. Every invalid pair resolves to `(5,000, 5,000)`.

#### Component Tests

- Render every source loading, ready, stale, unavailable, malformed, incompatible, and integrity-conflict state.
- Cover aligned, indexer-behind, snapshot-retained, and every row of the Evidence Reconciliation table.
- Cover `metadata-observation`, `world-initialized-event`, and `generation-advanced-event` provenance and all permitted null fields.
- Exercise coordinate entry and keyboard controls.
- Confirm selected bit, chunk, row, and bank highlighting agree.
- Confirm reduced-motion output does not depend on animation.
- Confirm all disclosures and source qualifications are keyboard accessible.

#### End-to-End Tests

- Load `/xray` directly under the deterministic fixture server.
- Navigate World -> X-Ray -> World using visible links.
- Inspect boundary cells and verify URL synchronization.
- Verify live fixture generation and provenance fields.
- Verify the page remains educational when chain, indexer, or both fail.
- Test desktop and 320-pixel mobile viewports for no horizontal page overflow.
- Test a landscape-mobile viewport for no horizontal page overflow and assert that controls, disclosures, exact values, and focus traversal remain visible and operable.
- Record a manual acceptance check in Chromium at actual 200% browser zoom for readability, control operation, focus traversal, and absence of two-dimensional page scrolling. Do not substitute CSS `zoom` or device scale factor for browser zoom.
- Test keyboard-only traversal, visible focus, heading structure, and accessible names.
- Test reduced motion.
- Verify live-region announcements and run an automated contrast scan where supported; record a manual WCAG AA contrast check for diagram edges that automation cannot evaluate.
- Assert that initial X-Ray loading does not request tile `.bin` files.

#### Required Verification per Phase

Run the narrowest relevant tests during development, then complete each phase with:

```text
npm --prefix apps/game-of-life run typecheck
npm --prefix apps/game-of-life run format:check
npm --prefix apps/game-of-life test
npm --prefix apps/game-of-life run test:chromium
npm --prefix apps/game-of-life run build
```

If repository script names differ, use the equivalent existing scripts and record the exact commands in the commit summary.

### Observability

The feature needs no new production telemetry for version one. Development diagnostics may use existing test fixtures and browser tools. User-facing source health must derive from validated source state, not from console logs.

## 5. Risks and Roadmap

### Phased Rollout

Each phase ends with code review, relevant tests, full application verification, and an independent commit.

#### Phase 1: Route, Workload Model, and Storage Atlas

Deliverables:

- Pathname-based `/xray` route and not-found behavior.
- World/X-Ray navigation.
- Pure workload constants, coordinate mapper, bank parity helper, formatting, and tests.
- X-Ray shell, hero, scale ladder, and bounded Storage Atlas.
- Responsive foundation, reduced-motion foundation, and direct-route E2E coverage.

Exit criteria:

- `/` remains behaviorally unchanged except for navigation.
- `/xray` loads directly and exposes the fixed world, encoding, row, chunk, and bank facts required by the atlas.
- The atlas contains no world-scale DOM expansion.
- Invalid paths do not silently render the world.

#### Phase 2: Cell Microscope

Deliverables:

- Validated coordinate inputs and optional atlas row selection.
- Exact byte, bit, part, byte-in-part, chunk-key, and bank mapping.
- Eight-bit accessible representation.
- Namespaced URL synchronization and boundary tests.
- Cross-highlighting between microscope, scale ladder, and atlas.

Exit criteria:

- Every valid world coordinate maps correctly.
- Invalid input preserves the last valid selection and explains the error.
- A copied or directly loaded coordinate reproduces the same selection.

#### Phase 3: Atomic Transaction and Compute Lens

Deliverables:

- Ordered transaction anatomy.
- Queue/request qualification.
- Read/compute/write/digest/metadata/event/commit trace.
- Fixed workload derivations and explicit evidence taxonomy.
- Atomic revert explanation and accessible reduced-motion alternative.

Exit criteria:

- The page makes the one-invocation claim accurately without inventing intermediate canonical states.
- Fixed facts, illustrative motion, configured limits, and unavailable receipt measurements cannot be confused.

#### Phase 4: Live Evidence and Proof Pipeline

Deliverables:

- Read-only chain and indexer evidence orchestration.
- Generation, population, digest, source block, transaction, request, and verification-time presentation.
- Chain/indexer/browser responsibility diagram.
- Independent source failure and integrity-conflict states.
- Honest comparison framework.

Exit criteria:

- Live data uses existing parsers and configured scope checks.
- Chain and indexed identities remain distinct under lag or failure.
- No private transaction runtime is initialized for X-Ray.
- No unsupported exclusivity or cross-chain performance claim appears.

#### Phase 5: Integration and Release Polish

Deliverables:

- Final responsive, keyboard, contrast, motion, and 200%-zoom pass.
- Complete desktop/mobile and failure-state E2E coverage.
- Bundle and request audit.
- Documentation updates for route fallback if required.
- Full repository verification.

Exit criteria:

- All success criteria in this specification pass.
- The initial X-Ray route requests no tiles or canonical chunk payloads.
- Existing world and transaction flows retain their test coverage and behavior.
- Every source-qualified claim has the appropriate inspectable support: deterministic formula, chain field, indexer provenance, receipt field, benchmark artifact with method and environment, configured value, or explicit illustrative disclosure.

### Technical Risks and Mitigations

| Risk                                                | Consequence                                    | Mitigation                                                                                               |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Dense technical content becomes a generic dashboard | The page loses explanatory force               | Use one scale narrative, connected diagrams, and progressive evidence details rather than repeated cards |
| Visual animation implies live measured execution    | Visitors mistake illustration for telemetry    | Label the trace `Illustrative`; separate it from receipt evidence and honor reduced motion               |
| Derived bank role is mistaken for direct metadata   | Provenance becomes misleading                  | Label it as generation-parity derivation and test large generations with `BigInt`                        |
| X-Ray duplicates synchronization logic incorrectly  | Chain/indexer states diverge from the explorer | Reuse clients, schemas, and poller; keep a smaller read-only source model                                |
| Direct `/xray` deployment returns 404               | Shared links fail outside development          | Require host fallback to `index.html` and test direct fixture navigation                                 |
| Atlas creates excessive DOM or SVG work             | Interaction and accessibility degrade          | Use constant-complexity patterns or canvas with accessible companion controls                            |
| Comparison copy overstates Groundhog evidence       | Demonstration credibility is damaged           | Use requirement questions and source labels; prohibit uncited exclusivity claims                         |
| Receipt data is unavailable through a stable API    | Compute panel tempts inferred measurements     | Show a clear unavailable state and never infer usage from gas budgets                                    |
| Existing world bundle is pulled into X-Ray          | X-Ray startup carries unnecessary WebGL cost   | Keep page imports separated and audit the production chunks in Phase 5                                   |
| Query keys collide with world camera state          | Links produce confusing navigation             | Reserve `cellX` and `cellY` for X-Ray and preserve unrelated parameters                                  |

### Open Extension Points

These are explicitly deferred and require separate evidence or design work:

- Link a selected exact world cell directly into the X-Ray microscope.
- Connect typed committed-receipt measurements and versioned benchmark artifacts.
- Add historical generation selection from retained immutable snapshots.
- Add chunk-level or tile-level cryptographic proofs.
- Publish reproducible cross-chain implementations and comparison results.
- Add a production deployment adapter and wallet-backed block explorer links.

## Definition of Done

Transaction X-Ray is complete when a visitor can load `/xray`, understand the complete cell-to-block workload, verify any coordinate's exact storage mapping, distinguish every claim by evidence source, inspect current validated generation provenance when services are available, and retain the full educational experience when they are not. The implementation must preserve the existing explorer, avoid world-scale DOM and data downloads, pass all required verification, and contain no unsupported performance or exclusivity claim.
