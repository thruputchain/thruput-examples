# React library integration

## Goal

Use the published `@groundhogchain/react@0.2.0` in token launchpad and swap so
these examples teach the official wallet and query APIs instead of maintaining
their own wallet lifecycle implementations. Keep application glue small and
transaction behavior intact.

## Decisions

- Pin the React package and TanStack Query in both app manifests. Keep client 0.9.
- Initialize one stable, network-validated public client per app configuration.
  Preserve same-origin RPC proxies, show startup failures with a retry action,
  and keep reads available without wallet permission once RPC initialization succeeds.
- Use the official wallet provider/hooks for discovery, connection, account and
  network changes, signing-client disposal, and batching capabilities.
- Retain app-specific write boundaries, gas/artifact policy, pre-broadcast durable
  persistence, receipt interpretation, and original-account/network recovery.
- Keep wallet controls and installation banners application-owned. Gate writes
  on connected status, not the presence of an address. Preserve quiet handling of
  the wallet's `4001 / Page closed` connection cancellation.
- Launchpad retains the last connected workflow account while disconnected so
  drafts and saved transactions remain visible. Switching accounts scopes the
  workflow to the new account; disconnected state never grants write permission.
- Token cards use independent `useTokenBalance` queries, concurrently across the
  visible page. Remove the ten-at-a-time enrichment pipeline. Registry metadata
  remains independent of wallet balance errors. Show loading/failure per card,
  keep cached balances during refresh, and use explicit 15-second visible polling.
- On confirmed launch completion, invalidate relevant account balance queries
  and request the existing registry sync. Imperative workflow validation continues
  to use fresh reads, not cached display balances.
- Swap retains coherent grouped pool/creation reads and height checks. Reuse the
  public client at React composition boundaries. Preserve account/binding-scoped
  route resets so a form cannot reuse an obsolete signing context.
- Keep counter, transaction observation APIs, generic contract-query abstractions,
  and broad registry/polling rewrites outside this workstream.

## Phases

### 1. Specification and setup

Verify released dependencies and current boundaries. Self-review this spec and
commit it before implementation.

### 2. Token launchpad

Replace the wallet lifecycle with initialized provider composition and a small
workflow/write adapter. Share the client with routes. Replace token enrichment
with card balance hooks and update affected tests and documentation.

Acceptance: public browsing, startup retry, connection cancellation, wrong-network
write gating, account switching, disconnect/reconnect draft retention, and existing
batch/persistence/recovery behavior continue to work. A failed token balance does
not hide registry metadata or other balances; account changes cannot show stale
balances. Review, run launchpad tests/typecheck/build, and commit.

### 3. Swap

Replace wallet lifecycle with the official provider and a small write/config
adapter. Share the initialized client with grouped readers/observers where the app
composes them; keep framework-neutral dependency injection for non-React callers.

Acceptance: read-only browsing, retryable RPC startup, quiet cancellation,
wrong-network gating, account/binding resets, and batching work with the released
package. Same-height snapshot and pre-broadcast persistence guarantees remain.
Review, run swap tests/typecheck/build, and commit.

### 4. Final verification and PR

Run workspace tests/typechecks and relevant browser acceptance checks supported by
the repository harness. Review the complete diff for avoidable abstractions,
duplicate lifecycle code, and obsolete tests. Update this document with outcomes,
commit, and open a PR from the integration branch into main.

Read Greptile's score in the PR description as well as its review threads. Evaluate
each finding, fix genuine issues, and reply inline either way. Request another
review with `@greptileai please rereview` after addressing findings. Pause for human
review when the latest commit has passing CI and a 5/5 with no remaining feedback.

## Verification approach

Adapt existing wallet, recovery, snapshot, and batching tests rather than duplicate
the library's lifecycle suite. Add focused coverage only for new application
boundaries: asynchronous startup/retry and independently refreshed token cards.
Use published packages, without sibling-source aliases or linked dependencies.

## Outcomes

- Phase 1: verified the published 0.2.0 package and self-reviewed this specification.
- Phase 2: launchpad uses the official provider and a shared initialized client.
  Removed custom wallet context/lifecycle and write-boundary disposal callbacks.
  Token cards now fetch concurrently with independent query state; registry
  metadata no longer carries balance state. Existing execution-time network checks
  remain at the transport boundary after startup validation.
  Launchpad: 400 tests pass; typecheck and production build pass. Focused coverage
  includes startup retry, draft/account isolation, cancellation, and a full
  20-token page with account changes and an isolated failing token.
- Phase 3: swap uses the official provider and client hooks, with a small
  binding-identity revision for existing route resets. Pool/creation/preview reads
  reuse the initialized client while grouped snapshot checks remain intact.
  Swap: 927 tests and typecheck pass. The optimized Vite build passes in test
  mode; the deployment build requires a provisioned pool-token artifact/hash,
  which this checkout does not contain. No deployment configuration was changed.
  Chromium acceptance passes for both apps at 320px and desktop widths, including
  wallet controls, launchpad handoff, and network-mismatch guards.
