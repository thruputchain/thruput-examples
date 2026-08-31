# Game of Life Transaction X-Ray

Status: Approved for implementation, revision 2

Date: 2026-08-30

## 1. Product Definition

### Problem

The Game of Life explorer shows immutable generations, but it does not let a visitor follow one concrete cell through storage and transition logic. The first X-Ray implementation accurately presented the contract, workload, evidence model, and comparison constraints, but most of that material behaved like a designed technical document rather than an interactive diagnostic tool.

### Solution

`/xray` is an evidence-backed cell debugger. A visitor selects a coordinate, explicitly loads the exact immutable data needed for that cell and its eight toroidal neighbors, evaluates the Conway rule, and follows the selected bit from its current bank location to the same expected location in the next generation.

The page answers one question:

> What happens to this exact cell when Groundhog advances one generation?

Detailed storage formulas, workload derivations, transaction semantics, evidence terminology, and comparison methodology belong in `contracts/game-of-life/README.md` and `apps/game-of-life/README.md`. The page links to those references instead of repeating them as long static sections.

### Product Principles

- Prefer direct manipulation, linked highlights, and state changes over explanatory prose.
- Show actual immutable cell values only after an explicit user request.
- Keep chain, indexer, browser-derived, and contract-derived facts visibly distinct.
- Never imply that the browser or indexer computes canonical next state.
- Never label a derived tile as independently proven; the indexer verifies the complete canonical download and digest, while individual tiles carry no proof.
- Never expose an invented intermediate canonical generation. The bank switch remains all or nothing.
- Keep the page useful when live sources are stale or unavailable.

### Success Criteria

- A visitor can choose any coordinate from `0` through `9,999` on both axes.
- Before explicit inspection, `/xray` requests metadata, manifest, and provenance only; it requests no tile or canonical chunk payload.
- Explicit inspection loads only the exact level-six tiles needed for the selected toroidal 3 by 3 neighborhood, with no adjacent prefetch.
- The page displays the actual selected cell value, all eight neighbor values, live-neighbor count, and browser-derived Conway result for the next generation.
- The page links the selected cell to its contract byte, bit, row part, chunk key, current bank value, and expected value at the same address in the next bank.
- Every result remains bound to the generation and digest used for its request, even if newer evidence arrives.
- A compact header indicator shows chain/indexer health and offers a manual refresh without exposing a separate evidence panel.
- The interface remains usable at 320 CSS pixels, in landscape mobile, at actual Chromium 200% zoom, with keyboard-only navigation and reduced motion.
- Typecheck, formatting, unit/component tests, Chromium tests, and production bundle checks pass.

## 2. Information Architecture

The page contains two regions in this order:

1. **Header:** World/X-Ray navigation and compact, refreshable evidence health.
2. **Cell Debugger:** compact title, coordinate controls, explicit inspection action, exact neighborhood, Conway result, packed storage address, and current-to-next bank value in one connected workspace.

The page must not contain long-form transaction anatomy, compute derivations, evidence glossaries, claim bundles, proof-pipeline essays, or cross-system comparison questionnaires. Those belong in the READMEs.

### Visual Direction

The page is a diagnostic instrument, not a marketing page or generic dashboard.

- Preserve the explorer's near-black canvas, green signal color, amber address color, and monospace data treatment.
- Use one connected workbench rather than a stack of page sections or unrelated cards.
- Use cells, bit positions, formulas, and a compact current-to-next bank trace. Do not use a hero, stage navigation, or decorative storage atlas.
- Keep prose short and operational.
- Use amber for the selected address and browser-derived next result, green for loaded immutable source values, and muted treatment for unavailable data.
- Use motion only to signal between already-known states. Reduced motion shows the same state without animation.

## 3. Cell Journey

### Coordinate Selection

The committed coordinate is initialized from `cellX` and `cellY` query parameters and defaults safely when either value is invalid.

Inputs:

- accept whole numbers from `0` through `9,999`;
- preserve the last valid selection when invalid input is submitted;
- show one inline error associated with the invalid fields;
- update `cellX` and `cellY` without removing unrelated query parameters;
- remain keyboard operable.

Changing the coordinate updates the address visualization immediately and clears any previous exact-data result. It does not fetch a tile until the user activates **Inspect exact cell**.

### Explicit Exact-Data Request

Inspection uses the currently displayed immutable snapshot. It is available whenever a validated snapshot value exists and is not rejected by an integrity conflict.

For the selected `(x, y)`, construct the toroidal coordinate set:

```text
(x - 1, y - 1)  (x, y - 1)  (x + 1, y - 1)
(x - 1, y)      (x, y)      (x + 1, y)
(x - 1, y + 1)  (x, y + 1)  (x + 1, y + 1)
```

Coordinates wrap across `0` and `9,999`. Map each coordinate to exact pyramid level `z = 6`:

```text
tile_x = floor(x / 256)
tile_y = floor(y / 256)
local_x = x % 256
local_y = y % 256
```

Deduplicate tile coordinates before loading. A neighborhood requires one tile normally and at most four tiles when it crosses tile boundaries or the world wrap.

Each response must:

- use `application/vnd.groundhog.life-cells-v1`;
- contain exactly `8,192` decoded bytes;
- remain under the configured indexer origin and immutable snapshot digest;
- be canceled when a newer inspection starts or the component unmounts;
- never trigger density-tile or adjacent-tile prefetch.

### Exact Cell Decoding

Each exact tile contains 256 rows of 32 packed bytes. Decode a cell as:

```text
byte_offset = local_y * 32 + floor(local_x / 8)
bit = local_x % 8
alive = (payload[byte_offset] >> bit) & 1
```

The result stores:

- selected coordinate;
- snapshot generation and state digest;
- source block height and verification time;
- each requested tile coordinate;
- all nine cell values;
- live-neighbor count;
- browser-derived next value.

The result must not silently change when polling observes a newer snapshot. It remains labeled with its original generation and digest until the visitor inspects again.

### Conway Evaluation

The browser derives the selected cell's expected next value from the exact neighborhood:

```text
next_alive = live_neighbors == 3 || (current_alive && live_neighbors == 2)
```

Label this value **Browser-derived from immutable snapshot cells**. It explains what the pinned Conway rule produces. It is not canonical state until a successful contract invocation commits the next generation.

### Connected Cell Trace

After inspection, the workbench presents all useful cell-level information together without selectable stages:

1. **Neighborhood and rule:** the actual 3 by 3 neighborhood, selected source value, live-neighbor count, applicable Conway outcome, and browser-derived next value.
2. **Packed storage:** the selected eight-cell byte, bit, contract byte, row part, byte in part, and substituted chunk-key calculation.
3. **Current and next location:** the source generation and bank, destination generation and bank, identical row/chunk/byte/bit address, current value, and browser-derived next value.

Generation, digest, source block, exact tile requests, and other provenance remain part of the validated evidence model but are not rendered as a separate page section. Transaction-wide atomic commit semantics remain in the contract README rather than the cell debugger.

## 4. Storage Mapping

The contract mapping remains:

```text
byte_in_row = floor(x / 8)
bit = x % 8
part = byte_in_row < 1000 ? 0 : 1
byte_in_part = part == 0 ? byte_in_row : byte_in_row - 1000
chunk_key = y * 2 + part
```

The implementation distinguishes two address spaces without presenting both in the primary trace:

- **Contract storage address:** byte, bit, part, byte-in-part, and chunk key in a persistent bank. This is the primary storage trace.
- **Indexer tile address:** immutable digest, level-six tile, local coordinate, and tile byte offset. This remains internal request provenance.

Never present an indexer tile coordinate as a contract chunk key.

Bank roles derive from the inspected snapshot generation, not whichever chain generation happens to be newest during rendering:

- even source generation: Bank A is source and Bank B is destination;
- odd source generation: Bank B is source and Bank A is destination.

The storage trace must explain the address rather than merely display it. For the selected cell it shows the substituted calculations, the selected bit inside its actual packed byte, and the chunk's row range:

```text
byte_in_row = floor(x / 8)
bit = x % 8
part = byte_in_row < 1000 ? 0 : 1
byte_in_part = part == 0 ? byte_in_row : byte_in_row - 1000
chunk_key = y * 2 + part
```

The bank trace shows the same row, chunk key, byte in part, and bit on both sides, with the current source value and browser-derived destination value. It must not imply that the browser computed or loaded the complete destination bank.

## 5. Evidence Health

Evidence validation remains active behind the debugger. On wide layouts, the header shows the current chain/indexer relationship and exposes a compact refresh action. On small layouts, it shows a colored status dot whose accessible refresh label includes the full current relationship. The page does not render a detailed evidence section, provenance table, or documentation panel.

The health indicator preserves these relationships without blending source identities:

- loading;
- aligned;
- indexer behind;
- chain only;
- retained snapshot;
- malformed or incompatible refresh with retained evidence;
- integrity conflict;
- both sources unavailable.

## 6. Documentation Ownership

`contracts/game-of-life/README.md` is authoritative for:

- canonical storage layout and cell-address formulas;
- two-bank topology;
- request and processing semantics;
- atomic commit and revert behavior;
- fixed read, write, compute, digest, population, and memory derivations;
- measured local execution results and unavailable receipt fields.

`apps/game-of-life/README.md` is authoritative for:

- X-Ray route and explicit inspection behavior;
- read-only runtime and bundle boundaries;
- chain/indexer/browser responsibilities;
- evidence types and reconciliation;
- tile-verification limits;
- comparison and claim guardrails.

The page may show short labels, current values, and links. It must not duplicate these documents as long-form static content.

## 7. Runtime and Security Boundaries

- `/xray` must not initialize personas, wallets, signing, submission, private transaction state, Deck.gl, Luma.gl, or the World renderer.
- Initial loading may perform one chain metadata request and one latest/manifest/provenance snapshot sequence.
- Exact tile requests occur only after explicit user activation.
- The production graph audit must follow all X-Ray static and reachable dynamic imports while excluding only the mutually exclusive World bootstrap edge.
- The read-only RPC proxy continues to allow only the required view methods.
- Production hosts rewrite `/xray` and `/xray/` to `/index.html` while preserving query parameters.

## 8. Accessibility and Responsive Behavior

- Use one `h1` and sequential headings.
- Every control has an accessible name and visible keyboard focus.
- Loading, success, stale result, and failure changes are announced politely.
- Alive/dead cells use text or accessible labels in addition to color.
- The neighborhood and bit view remain understandable without animation.
- At 320 CSS pixels and landscape mobile, controls, exact values, the evidence-health action, and focus traversal remain operable.
- Actual Chromium 200% zoom produces no two-dimensional page scrolling; explicitly labeled horizontal data strips may scroll internally.
- Honor `prefers-reduced-motion`.

## 9. Verification

Unit and component coverage must include:

- toroidal neighborhood coordinates at corners and edges;
- tile deduplication across normal, tile-boundary, and world-wrap selections;
- exact LSB-first decoding;
- Conway birth, survival, loneliness, and overcrowding;
- response type and length rejection;
- cancellation and stale-result suppression;
- plain-language storage steps with substituted formulas;
- snapshot-bound bank roles;
- evidence relationships and unavailable states.

Chromium coverage must include:

- no tile request before explicit inspection;
- exact tile request count and paths after inspection;
- actual neighborhood values and derived result;
- coordinate URL synchronization;
- keyboard-only coordinate submission, inspection, and evidence refresh;
- chain, indexer, malformed, retained, and integrity-conflict states;
- direct `/xray` and `/xray/` loading;
- 320-pixel portrait and mobile landscape layouts;
- reduced motion, heading structure, accessible names, live regions, contrast, and clipping checks.

Complete the redesign with:

```text
npm --prefix apps/game-of-life run typecheck
npm --prefix apps/game-of-life run format:check
npm --prefix apps/game-of-life test
npm --prefix apps/game-of-life run test:chromium
npm --prefix apps/game-of-life run build
```

## 10. Non-Goals

- Rendering the complete world on `/xray`.
- Computing or submitting a canonical generation in the browser.
- Loading canonical bank chunks into the browser.
- Claiming an individual tile proof.
- Showing invented execution timing or intermediate canonical state.
- Replacing the World route, transaction controls, or indexer.
- Ranking other systems without cited, reproducible evidence.
