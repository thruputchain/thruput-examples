# Phase 6 Evidence

Date: 2026-08-29

## Result

Phase 6 adds loopback-only Alice, Bob, and Carol identities; measured request and crank policies; policy-aware signing and recovery; separate durable request and crank histories; event correlation and retention-gap handling; automatic and manual controls; cross-tab reconciliation; and a credential-gated development proxy.

## Measured Policies

The request feasibility test now accepts explicit profile values and records elapsed time.

- Two concurrent `request_tick` transactions committed in one block at `100,000` outer gas and `100,000` target gas with a 64-block expiry in 1.01 seconds.
- The same pair deterministically faulted at `10,000` outer and target gas.
- The generated request profile therefore uses the demonstrated 10x-safe value of `100,000` for both layers, a 64-block bounded expiry, and a 30-second observation window.
- A full `process_next_tick` committed with `10,010,000,000` outer gas, `10,000,000,000` target gas, and a two-block expiry in 7.04 seconds.
- The generated crank profile retains the demonstrated gas values and uses a 300-second observation window.

An intentionally retained pending crank on the first calibration ledger continued to report `pending` after its expiry height. The client correctly classified it as indeterminate and did not replace it. A clean funded ledger then passed the complete multi-persona integration.

## Verification

```text
npm run check:contracts
  passed; committed generated binding matches the current contract

npm run typecheck
  passed

npm test
  23 files passed, 1 local-integration file skipped by default
  148 tests passed, 1 skipped

RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 npm run test:integration:local
  1 test passed in 28.47 seconds on the final verification run
  Alice, Bob, and Carol admission events matched their expected callers
  Bob processed queued requests, including requests submitted by other personas
  the final empty crank committed with typed None and no GenerationAdvanced event

npm run test:chromium
  24 Chromium tests passed after Phase 6 UI integration

npm run build
  passed
  production output was scanned for a derived disposable private-key canary; none was present

cargo fmt --all -- --check
  passed

git diff --check
  passed
```

## Security Boundary

- `.env.local` is ignored and written with mode `0600`.
- Setup requires the pinned local DevWallet code hash, validates the manifest entrypoint, derives each signer, verifies each public key and wallet root, and funds every persona for a full crank. It enables the generated environment only if live `TickRequested` events prove all three effective callers and Bob drains the queue successfully.
- Credential injection is disabled for production builds and previews.
- Credential-bearing development requests require a loopback host and reject cross-site or mismatched-origin requests.
- Write RPC methods are enabled only for credential-bearing development serve.
- CSP permits no remote scripts.

## Remaining Risk

- The local RPC's event source currently reports history from block zero but does not promise contract-lifetime retention. The UI states the finite-window limitation and durably marks uncovered requests as permanently unknown.
- SwiftShader proves browser correctness, not physical GPU or mobile-device performance. Phase 7 records reference-device measurements.
- The production JavaScript bundle remains approximately 1.23 MB minified. Phase 7 reviews whether code splitting improves startup without weakening renderer ownership.
