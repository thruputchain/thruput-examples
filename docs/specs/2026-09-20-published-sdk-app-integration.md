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

Implementation and verification results will be recorded here as phases finish.
