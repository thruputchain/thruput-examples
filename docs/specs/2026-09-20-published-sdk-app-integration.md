# Integrate published Groundhog APIs in Swap and Token Launchpad

## Goal

Make both examples teach the published Groundhog APIs directly. Replace application-owned transaction plumbing and repetitive contract context with the new typed bindings, client helpers, and React query primitives. Preserve the common application structure established in #105 and the domain checks that make each workflow correct.

Base: `main` after #105. Branch: `feat/published-sdk-app-integration`.

Published targets: client-ts 0.10.0, React 0.3.0, CLI/codegen 0.18.0, Rust SDK 0.36.0, and standard interfaces 0.1.33. Contract artifacts and bindings must be rebuilt together: scalar event topic encoding changed in the Rust SDK.

## Architecture and behavior

- Keep `main → App → AppProviders → AppLayout → AppRoutes` and the existing directory ownership in both apps. Each remains independently understandable; do not introduce a cross-app framework.
- Keep generated files under `src/contracts/generated`, client initialization under `groundhog`, and transaction persistence/recovery under `transactions`.
- Use SDK execution and receipt observation for prepare/sign/persist/submit/wait. Persist the exact approved hash before broadcast, submit once, and recover uncertain outcomes through public reads, including after disconnect.
- Retain capability-aware atomic batching and sequential fallback. A rejected or uncertain batch must never silently become a fresh sequential transaction.
- Keep root receipts intact. Use typed calls and `decodeExecution` for child results rather than rewriting receipt return data or manually indexing wallet return arrays.
- Use bound contracts for repeated view context. Use React contract-view query primitives for independent UI reads where they simplify the current code. Retain the coherent Swap snapshot query and Launchpad's post-commit height checks.
- Preserve queued Swap request observation: an enqueue receipt is not proof that the swap completed.
- Preserve workflow revisions, locks, account/network binding, original-network recovery, artifact verification, factory/event verification, and explicit retry decisions.
- Keep calibrated gas budgets explicit; use `walletGasLimit` to sum child budgets rather than presenting it as estimation.

## Phases and commits

### 1. Published dependencies and generated bindings

Update workspace package pins and the lockfile to the published client and React versions. Align the Rust dependencies and CLI minimum needed to rebuild matching contract specs. Regenerate bindings with the released CLI; never hand-edit generated TypeScript. Check affected fixtures, compile the workspace, and commit the dependency/codegen phase independently.

The checkout starts with four uncommitted new-wallet-method mock stubs in Swap's provider-wallet test. Preserve them and incorporate them only if that test is deliberately migrated as part of this work.

### 2. Client transaction boundaries

Simplify both `transactions/provider-wallet.ts` implementations with SDK execution helpers. Replace duplicate polling with `waitForTransactionReceipt`, mapping SDK outcomes into the existing workflow result union. Remove Launchpad's single/batch receipt rewriting and decode typed calls against the original receipt, including persisted recovery. Apply bound views and deployment helpers where the existing setup/read code duplicates those APIs.

Tests must cover persistence failure before broadcast, rejected signing, committed failure, uncertain submission, invalid/dropped/timeout observations, recovery without wallet permission, batch call order, and malformed child results. Keep the workflow tests focused on domain decisions rather than SDK internals.

### 3. React and developer-facing simplification

Adopt the published React query/execution primitives where they own the whole operation cleanly. Avoid wrapping a persisted multi-step state machine in an unrelated mutation just to use a new hook. Keep feature query invalidation explicit and cancellation connected to reads. Explain the division between public queries, wallet execution, and app workflow state in matching README sections.

Review both apps side by side for consistent names, file ownership, and abstraction depth. Remove obsolete helpers and tests of removed plumbing rather than retaining forwarding APIs.

### 4. Acceptance and draft PR

Run workspace typechecks, tests, production builds, browser acceptance, binding regeneration checks, and available live-node wallet acceptance. Review the complete diff against main, record test results and any actual environment blockers here, and commit final fixes/documentation. Push and open a draft PR with concrete before/after snippets and measured handwritten-code changes, distinguishing generated changes from application simplification.

## Verification commands

Use Node 24 and npm. Use the published CLI via `GROUNDHOG_CLI`.

```bash
npm ci
npm run typecheck
npm test
npm run build --workspaces
npm run test:browser
npm run test:wallet
git diff --check
```

Run focused tests as each phase changes behavior; run the full suite at the end. Inspect setup and CI commands before selecting Rust and live-node checks. Do not claim a live-chain pass from mocked RPC tests.

## Completion record

Completed on `feat/published-sdk-app-integration`.

### Implementation

- Installed published client 0.10.0 and React 0.3.0 through the registry lockfile. Updated Rust SDK/interface/RPC pins and the CLI minimum/CI pin. Rebuilt contracts and regenerated all eight workspace bindings, including Counter because it shares the Rust workspace and client dependency.
- Launchpad uses typed `ContractCall` descriptors, `executeCallsAndWait`, and `decodeExecution`. Removed receipt rewriting, `observeBatch`, and the unused outcome module. Malformed child returns retain the committed root receipt and never become permission to resubmit.
- Swap uses `executeAndWait` for single writes. Its event-driven raw batches keep explicit prepare/sign/persist, then delegate submission observation to `submitAndObserve`; no synthetic typed decoder was introduced for queue workflows.
- Both apps map SDK receipt outcomes into their existing workflow states and use `walletGasLimit` for explicit batch budgets. Network pins, exact-hash persistence, artifact checks, locks, and capability selection remain enforced.
- Bound token/factory views replace repeated client/address arguments. Both provisioning scripts use `prepareContractDeployment`, prefunding, `deployContractAndWait`, and `executeAndWait`.
- Matching `transactions/use-transactions.ts` hooks integrate React's `transactionReceiptQueryOptions` for cached, deduplicated public recovery. Regression tests cover disconnected observation, failed committed receipts, explicit retry after timeout, and wrong-network rejection. Existing independent balance hooks and coherent snapshot queries remain appropriate; wrapping a persisted multi-step workflow in `useExecute` would add a competing state model.
- Kept the application shell and directory ownership from #105. Updated matching README sections and documented that regenerated bindings require rebuilt deployments; historical Devnet deployments were not modified.
- Incorporated the pre-existing four Swap wallet-mock stubs while migrating that test deliberately.

### Issues found during verification

- Updated Rust test expectations for direct integer topics and interface version 0.1.33.
- The production acceptance harness omitted the new `shared/` directory from #105. It now copies that directory with the isolated production app.
- Faster receipt observation exposed stale views during sequential launches. Launchpad now retries only proven stale funding views with a bounded delay; a fresh shortfall still stops immediately and funding is never resent.
- Swap's creation review treated mismatched factory view heights as inconsistent addresses. It now retries the coherent read; different addresses at the same height still fail. Both cases have regression coverage.

### Verification

- Clean `npm ci` and workspace/seed typechecks passed on Node 24.21.0.
- All 1,327 Vitest tests passed: Counter 47, Swap 876, Launchpad 365, shared seeds 39. All three process-cleanup tests passed.
- All three production builds passed; browser fixtures passed at desktop and 320px widths in Chromium 152.
- `cargo test --all --locked`, workspace Clippy with warnings denied, and `cargo fmt --check` passed. Tests explicitly marked as requiring separate live/guest harnesses remain ignored in the native suite.
- Repeated Swap/Launchpad generation produced no binding diff; the CLI version-check suite passed all 23 cases.
- Live atomic wallet acceptance passed all 20 checks with CLI 0.18.0 and hog-devnode 0.1.27-rc.7. Evidence: `/tmp/groundhog-wallet-apps-rb1jvA/evidence`.
- Live sequential fallback acceptance passed all 20 checks with the same tools. Evidence: `/tmp/groundhog-wallet-apps-xSIpku/evidence`.
- Both live runs covered two token launches, pool creation, independent balances/reserves/LP evidence, rejection, swap/add/remove, reconnect, wallet transfer, and real production server startup. No external Devnet writes were requested. Harness cleanup verified owned processes exited and user app environments were unchanged.

### Simplification measurements

Compared with main, the two provisioning scripts remove 40 net lines. The Swap ERC20 adapter and Launchpad token verification remove another 23 net lines, and the obsolete Launchpad outcome module removes 41 lines. These are scoped source reductions, not a claim that the whole diff shrinks: generated metadata, regression tests, and shared receipt-cache integration add code. The larger benefit is that the SDK now owns polling, wallet return decoding, deployment identity checks, and transaction lifecycle ordering.

### Counter follow-up

At the user's request, this PR also simplifies Counter's setup and public reads. Provisioning now uses `prepareContractDeployment`, prefunding, `deployContractAndWait`, and `executeAndWait`; the worker's Counter reader binds once with `getContract`. Updated CLI guidance explains the distinction between sequential setup and concurrent interactive submissions. Counter's provisioning script removes another 24 net lines, bringing the three provisioning scripts' combined reduction to 64 lines.

Counter's server-signing boundary and separate bounded submission/observation queues are preserved. Tests verify funding precedes deployment, initialization follows commitment, and failures preserve the existing private environment file.

- All 49 Counter tests, browser/server/setup typechecks, and the production build passed.
- `test:counter` passed with CLI 0.18.0 and hog-devnode 0.1.27-rc.7: two fresh setups, 120/120 burst confirmations with the exact final value, 42/42 browser confirmations, signer top-up, keyboard controls, reconnect, mobile layout, and Vite development-server submission.
- Live evidence and screenshots: `/tmp/groundhog-counter-hBuBZE`.
- The first live run reached the mobile-header assertion before layout settled after resizing. The harness now awaits fonts and the resized frame before measuring; the exact no-resize assertion remains in place.
