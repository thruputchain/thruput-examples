# Phase 7 Evidence

Phase 7 joins the contract, indexer, browser, and transaction workflow in one disposable clean-ledger command. It also records the limits of software-only browser measurements.

## Reference Host

- CPU: Intel Core Ultra 9 285H, 16 logical CPUs
- Memory: 62 GiB
- OS: x86_64 Linux 7.1.9-arch1-2
- Browser: Chromium with SwiftShader
- Desktop viewport: 1440 by 900 CSS pixels
- Mobile profile: 412 by 915 CSS pixels, emulated on the same host

The mobile profile is not a physical mid-range phone. Its frame result is a repeatable software gate, not a physical-device performance claim.

## Clean-Ledger Run

Command:

```bash
GROUNDHOG_CLI=/path/to/groundhog \
GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
GROUNDHOG_CONTRACT_ARTIFACTS_DIR=/path/to/built_contracts \
GROUNDHOG_E2E_HOGD_PROTOCOL=hogp/81e1cb073cfb \
npm run test:e2e:local
```

Functional result: passed from a fresh ledger in 62.459 seconds.

- Full 100-million-cell initialization: 2.130 seconds
- Alice, Bob, and Carol caller verification, including three full cranks: 24.488 seconds
- First complete index publication: 2.612 seconds
- Browser journey: 29.352 seconds
- Indexer restart from durable SQLite evidence and immutable artifacts, without a rebuild: passed
- Two retained generation trees: 167,513,296 apparent bytes
- One generation's generated artifacts: 83,756,392 bytes

The browser started at generation 3, submitted one request, committed one separate crank, correlated the matching completion, observed generation 4 publication, waited for digest-qualified GPU ownership, reloaded the page, and recovered the advanced durable record.

## Index Measurements

| Generation | Download | Tile build | Publication | Total |
| --- | ---: | ---: | ---: | ---: |
| 3 | 2.317 s | 0.222 s | 0.046 s | 2.598 s |
| 4 | 2.330 s | 0.213 s | 0.048 s | 2.605 s |

The indexer emits these values as `game_of_life_indexer_metric` records. Chunk reads remain bounded at 32. Publication remains single-writer, immutable, and crash-safe; focused service tests cover interrupted artifacts, interrupted promotion, restart recovery, retention, and mixed-generation rejection.

## Browser Measurements

| Measurement | Result |
| --- | ---: |
| First content | 304.95 ms |
| First ready visualization and visible GPU coverage | 1,384.83 ms |
| Request-to-visible-generation switch | 22,495.93 ms |
| Desktop interaction-frame p95 | 16.8 ms, strict budget missed |
| Emulated-mobile interaction-frame p95 | 16.8 ms, budget met |
| Peak observed JavaScript heap during generation switch | 92,362,325 bytes |

The generation-switch measurement includes request admission, the full atomic crank, indexer polling, complete snapshot download, tile build and publication, browser polling, visible-tile loading, and renderer ownership. The UI makes no latency promise.

The interaction sampler dispatches a camera action on every measured frame. The strict desktop threshold was missed before rounding; the mobile-profile threshold passed. Existing cache tests enforce the separate 64 MiB decoded CPU and 64 MiB app-owned GPU limits. Chromium exposes JavaScript heap, not total browser-process memory, so the continuously sampled heap is a proxy rather than a total-memory claim.

## Hardening Matrix

- RPC and indexer loss, stale status, malformed status, latest-pointer loss, reduced motion, WebGL absence, allocation failure, real context loss and restoration, missing tiles, and digest supersession: Chromium fixture tests.
- Mobile portrait, mobile landscape, tablet, desktop, keyboard camera control, focus trap, focus restoration, accessible names, and live announcements: Chromium fixture tests.
- Ambiguous submission, indeterminate original-hash recovery, hashless signing confirmation, event retention gaps, pagination, lifecycle invariants, cross-tab serialization, and malformed durable storage: unit and component tests.
- Interrupted publication, promotion interruption, event lag, mixed downloads, writer exclusion, restart recovery, and immutable collision handling: indexer service tests.
- Clean deployment, prefunding, initialization, caller verification, request, crank, indexing, publication, generation switch, durable reload, and indexer restart: `npm run test:e2e:local`.

## Verification

```text
npm run verify
  generated contract binding matched
  formatting passed
  typecheck passed
  23 test files passed, 1 local-integration file skipped by default
  148 tests passed, 1 skipped
  production build passed

npm run test:chromium
  26 tests passed

cargo test -p game-of-life-indexer --locked
  45 tests passed, 2 long-running tests skipped

cargo test -p game-of-life-core --locked
  8 tests passed, 1 full-scale reference test skipped

cargo fmt --all -- --check
bash -n apps/game-of-life/scripts/setup-local.sh
bash -n apps/game-of-life/scripts/test-clean-ledger.sh
git diff --check
```

A production build with an injected private-key canary contained no canary bytes. The generated binding matched the current contract specification. Git review found no tracked private key, signed transaction, local database, generated tile tree, or machine-specific deployment address.

## Dependency Disposition

`npm audit --omit=dev` reports eight high-severity entries rooted in `@deck.gl/geo-layers`. The actionable advisories affect `image-size` parsers reached through glTF and texture-compression modules. The application accepts only its strict binary density and cell tile schemas; it does not invoke the vulnerable image, glTF, 3D Tiles, or texture-compression paths. npm proposes an incompatible deck.gl 8 downgrade, so the verified 9.3.10 renderer remains pinned pending an upstream-compatible fix.

`cargo-audit` was not installed on the reference host, and the pinned `nightly-2026-07-01` toolchain does not provide an applicable Clippy component. Rust dependencies remain lockfile-pinned and covered by compilation and tests; Clippy and a Rust advisory-database scan remain external release-environment checks.

## Residual Limits

- SwiftShader does not prove physical GPU or mobile-device performance.
- Chromium's JavaScript heap metric does not measure complete browser-process memory.
- The strict desktop interaction-frame budget was missed before rounding. No budget adjustment has been approved.
- The 1.227 MB minified application bundle remains above Vite's warning threshold. The renderer is the primary application surface, so Phase 7 keeps its ownership path static rather than introducing an unmeasured asynchronous split.
- Local RPC event retention is finite. Requests outside that window remain permanently unknown, as documented in the interface.

The functional hardening work is complete, but Phase 7's performance exit gate remains open pending a named physical mid-range mobile run, total browser-memory measurement, and either a desktop result below 16.7 ms or an approved budget adjustment.
