# Phase 4 Evidence

## Scope

This evidence covers the read-only Game of Life explorer in `apps/game-of-life`. The browser accepts a snapshot only when its configured network and contract scope and all stable world fields match current chain metadata.

## Automated Verification

The local verification matrix includes:

- A clean lockfile install with `npm ci`.
- A non-mutating generated-binding drift check against a fresh Groundhog CLI build.
- TypeScript checks for browser and Vite configuration code.
- Unit tests for normalized configuration, root-only indexer targets, strict artifact schemas, current-chain eligibility and poll integrity, proxy policy, camera bounds, pyramid hysteresis, multi-chunk and encoded tile responses, cache-populating prefetch, independent cancellation, worker and replacement-factory failure, and active GPU ownership.
- SwiftShader Chromium tests for same-origin artifact routing, fitted initial camera state, toolbar/wheel/drag/keyboard camera control, pointer and keyboard inspection, at most eight concurrent tile requests, a targeted 404 hatch that differs from the normal canvas, WebGL2 fallback, real `WEBGL_lose_context` restoration followed by fresh interaction, 320 CSS pixel layout, and repeated renderer teardown.
- A production Vite build and formatting/diff checks.

The E2E fixture returns a real ABI-encoded `get_metadata` result and immutable artifacts for the configured world. It therefore exercises chain eligibility rather than bypassing it.

## Security Boundary

- Browser RPC and indexer traffic uses same-origin loopback proxies in development and preview.
- The RPC proxy permits only the three required read methods and bounds request and response bodies.
- The indexer proxy permits only canonical paths for the configured world, rejects queries and encoded/traversal paths, follows no redirects, validates response MIME types, and bounds streamed upstream bodies before forwarding them.
- Browser code contains no wallet integration, credentials, write RPC method, or write contract method.

## Resource Boundary

- Visible tile work has seven request slots; idle prefetch has one separately reserved slot and is canceled when the selected viewport changes.
- Prefetched tiles use the normal decode workers and digest-keyed CPU cache, so a later visible request reuses decoded data.
- Tile decode uses at most two replaceable workers.
- Decoded CPU data and app-owned GPU allocations have independent byte budgets.
- GPU accounting covers integer texture storage and layer-owned position/UV vertex buffers. Shared driver, shader-program, and deck.gl framework allocations are outside this app-level accounting.
- A layer releases its own GPU reservation and resources. Budget pressure never finalizes a resource still owned by a mounted layer.

## Measurement Limits

Chromium runs locally with SwiftShader (`--use-angle=swiftshader`) and is software-emulated. The 320 CSS pixel test verifies responsive layout but is not a physical mobile-device measurement. No claim is made here for hardware GPU throughput, peak device memory, battery use, thermal behavior, frame-time percentiles, or mobile browser performance.

Those hardware performance gates remain for Phase 7 and require measured target devices and production-like indexer/network conditions.

## Dependency Audit

`npm audit` currently reports eight high-severity advisories through the pinned deck.gl loader dependency chain. The proposed forced remediation downgrades deck.gl and violates the required Phase 4 version boundary, so it is not applied. This is a recorded upstream dependency risk rather than an ignored clean result.

`@deck.gl/extensions`, `@deck.gl/mesh-layers`, and `@loaders.gl/core` are not direct app dependencies because app source does not import them. npm still installs compatible versions transitively because `@deck.gl/geo-layers@9.3.10` declares all three as peer dependencies.
