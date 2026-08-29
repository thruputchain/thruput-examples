# Phase 5 Evidence

## Scope

This evidence covers the read-only product shell and generation synchronization in `apps/game-of-life`. It does not cover requests, cranks, wallets, personas, transactions, or physical-device performance.

## Synchronization Boundary

- Chain metadata, the latest pointer and immutable artifacts, and indexer status are independent visible-document pollers with request timeouts, bounded backoff, and immediate visibility-restoration refresh. Genuine timeouts commit source failure state; pause, disposal, and supersession suppress stale completions.
- A pure reducer stores chain state, candidate preparation, renderer transition, visualized ownership, and indexer health separately.
- Lower candidates are ignored. Equal-generation digest conflicts become integrity errors. Transient source failures retain the last verified visualization.
- Current metadata can validate an exact snapshot. Retained `WorldInitialized` and `GenerationAdvanced` provenance can validate historical snapshots under the configured local-indexer trust boundary when scope, seed, and dimensions remain stable. Metadata-observation provenance is current-only.
- Every accepted chain metadata change revalidates the staged candidate. Renderer approval checks the current chain, epoch, and digest synchronously before any ownership swap, so invalidation and frame completion cannot diverge.
- Indexer status becomes stale after 15 seconds and affects health presentation only. It never authenticates artifacts.

## Renderer Boundary

- Before initial ownership, the eligible snapshot remains an epoch-bound candidate. Its digest-keyed renderer mounts at zero opacity and may remount only if another initial digest supersedes it. After first ownership, one mounted `WorldRenderer` retains camera and WebGL state across generation changes.
- Displayed and candidate snapshots use separate immutable digest-keyed layers and loaders. A layer never mixes digests.
- Both layers share seven visible request slots, one prefetch slot, two decode workers, a 32 MiB decoded cache, and one 64 MiB live GPU budget. Each deck layer has a separate 16 MiB tile cache, which caps aggregate CPU ownership at 64 MiB.
- Level-six ownership requires a digest-qualified GPU resource for every visible selected tile. Density levels permit render-ready selected tiles or their immediate parents only. Camera selection changes invalidate the gate.
- The old layer and old-generation inspection remain authoritative until renderer ownership commits. Camera and URL state do not change.
- Initial and later ownership use the same digest-qualified coverage rules. Initial ownership requires a render-ready selection, a confirmed hidden frame, and a confirmed revealed frame. The old layer stays fully opaque while a later candidate ramps from transparent to opaque. Normal mode crossfades complete digest layers; reduced motion switches without blending. Custom shaders emit straight alpha to match deck.gl's default `SRC_ALPHA` blend factors and apply opacity once.
- Candidate supersession aborts obsolete work. Context loss cancels a transition and restages coverage after restoration.

## Interface And Accessibility

- The full-bleed world uses a compact top bar, floating generation state, desktop activity/details rail, and focus-managed mobile bottom sheets.
- Chain, preparation, visualization, status progress/error/retry, population, digest, seed, dimensions, contract, source block/hash, and provenance remain available without relying on color.
- Mobile controls are at least 48 by 48 CSS pixels at 320 CSS pixels and account for the safe-area inset.
- Pointer inspection is silent. Keyboard inspection clears pointer state and announces exact cell semantics through one deduplicated polite live region.
- WebGL unavailability or context loss removes Ready and active-visualization claims, disables renderer controls and focus, and retains verified snapshot metadata. Indexer and latest-pointer failures retain the owned world and independent chain state.

## Automated Verification

- `npm run check:contracts`: generated binding matches the current contract.
- `npm run typecheck`: browser and Vite TypeScript projects pass.
- `npm test`: 125 tests across 17 files pass. Coverage includes initial candidate state, synchronization conflicts, stale commit rejection, exact eligibility, 15-second status freshness, timeout and visibility polling, GPU coverage rules, aggregate budgets, pinning, and straight-alpha opacity math.
- `npm run test:chromium`: 23 deterministic Chromium tests pass. The fixture holds and releases only the newer digest's exact tile while old resources remain unaffected. The suite covers delayed, missing, malformed, allocation-failed, and superseded initial candidates; digest-specific exact pixels; chain advancement during staging; reduced motion; latest/status failures; keyboard live-region semantics; WebGL loss and restoration; request concurrency; safe-area target bounds and overlap; and retained inspection behavior.
- Production build, final formatting, diff checks, and dependency audit are part of the final verification run.

## Verification Language

The interface states: **Snapshot verified by indexer against the complete on-chain digest; individual tiles do not carry proofs.** The indexer derives visualization artifacts from committed state. No queue depth, fairness, latency, cryptographically verified tile, or Merkle-proof claim is made.

## Measurement Limits

Chromium runs locally with SwiftShader and is software-emulated. Responsive browser tests are not physical mobile-device evidence. No claim is made for hardware GPU throughput, peak device memory, battery use, thermal behavior, or frame-time percentiles. Those measurements remain a later acceptance activity.

## Dependency Audit

`npm audit` reports eight high-severity advisories in the pinned deck.gl loader dependency chain. The forced remediation would downgrade required deck.gl packages, so it is not applied. The focus-managed Sheet adds the narrow `@radix-ui/react-dialog` dependency rather than the aggregate Radix package.
