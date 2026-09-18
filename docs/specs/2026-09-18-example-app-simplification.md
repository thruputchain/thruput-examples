# Simplify the Groundhog example apps

Status: approved in Roughdraft on 2026-09-18; implementation in progress.

Branch: `refactor/example-app-simplification`, stacked on `feat/react-wallet-integration` at `4451881` ([PR #104](https://github.com/groundhogchain/groundhog-examples/pull/104)). The eventual PR should target that branch while #104 is open. After #104 merges, retarget/rebase the stack onto main, keeping the integration commits out of this PR's diff.

## 1. Objective and recommendation

Make swap, token launchpad, and counter easier to understand and modify. Prefer fewer concepts, explicit dependencies, and ordinary application code over clever optimizations or another layer of generic infrastructure.

The largest gains are in swap and launchpad. Counter is already a smaller, coherent example; its cleanup should be correspondingly smaller.

Paths below are relative to the named app unless they explicitly start with `apps/`, `docs/`, or `tests/`.

Recommended scope:

1. Delete proven dead code and obsolete compatibility scaffolding.

2. Give the browser one RPC endpoint and one runtime configuration source.

3. Reduce wallet setup to provider composition and wallet UI.

4. Replace duplicated read scheduling with the TanStack Query already installed.

5. Remove redundant application state and unnecessary wrapper APIs.

6. Consolidate development/production server plumbing within each app.

7. Apply small, concrete counter cleanup without changing its worker scheduler.

The main architectural change proposed for approval is **runtime public configuration for swap and launchpad**, following counter's existing `/api/config` pattern. This intentionally changes configuration delivery, not just filenames.

Transaction lifecycle APIs, `formatUnits`/`parseUnits`, and further client-ts/React package features remain in the upcoming SDK workstream. This plan uses the released client 0.9 and React 0.2 APIs.

## 2. What the audit found

Reviewed application entrypoints, wallet composition, read clients, configuration, directory queries, contract adapters, workflow integration, server routing and registry boundaries, setup scripts, deployment configuration, and test entrypoints. Generated bindings and checked-in UI primitives were inspected as dependencies, not treated as hand-maintained application logic.

A scoped Knip pass included the three apps, tests, setup scripts, and counter's worker entrypoint. Vite/Vitest configuration execution was disabled for that pass because build configuration requires provisioned artifacts. Repository searches were used to check candidates; dynamically launched test helpers were retained. The scan found one unused app source file: swap's generated DevWallet binding. Most other findings were unnecessary exports, not unused implementations.

| Area                      | Evidence                                                                                                                                 | Proposed improvement                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Wallet setup              | Both `src/wallet/wallet-provider.tsx` files combine bootstrap, provider composition, writer distribution, and account scoping            | Separate app setup from workflow state; remove the extra write context                     |
| RPC selection             | Both `src/groundhog/client.ts` files infer proxy routing from `registryEnabled` and hostnames                                            | Browser uses `/groundhog-rpc`; server owns upstream configuration                          |
| Public config             | Both wallet apps bake environment settings into assets, substitute a fake browser RPC URL, and verify a hashed build manifest            | Fetch validated public config at runtime, as counter already does                          |
| Fixed feature flags       | Both config loaders set `registryEnabled: true` regardless of environment flags                                                          | Remove the unsupported registry-off configuration surface                                  |
| Swap client construction  | `createReadClient` still hides asynchronous initialization behind a `Proxy`; helper APIs silently create more clients                    | Require an initialized client at read/workflow composition boundaries                      |
| Swap read scheduling      | `use-pool-snapshot.ts`, `token-preview.ts`, `token-address-combobox.tsx`, and `pool-directory-page.tsx` each own request lifecycle state | Use normal query options/hooks, preserving grouped reads                                   |
| Launchpad directory state | `use-token-directory.ts` stores both `page` and token metadata derived from that page                                                    | Keep one page result and derive the card data                                              |
| Legacy swap storage       | `hasLegacyOutstandingRequest()` always returns false; `migrateRequestCollection()` only loads the current collection under a lock        | Remove misleading migration paths and unused v2 storage implementation                     |
| Unused binding            | `contracts/generated/dev-wallet.ts` has no consumer but is still generated from a checked-in spec                                        | Remove the generated file, spec, checksum, and generation step together                    |
| Launchpad flags           | `writesSupported` defaults to true and has no supplied false value in the checked call graph                                             | Remove the flag and unreachable unsupported-writes UI; retain connection/capability checks |
| Server duplication        | Vite config and `server/http.ts` implement separate RPC proxy paths                                                                      | Reuse one app-owned handler in development and production                                  |
| Counter                   | Runtime config, one worker, one bounded scheduler, and direct generated contract calls already form a clear path                         | Keep that architecture; simplify small surrounding details                                 |

The large swap files are real hotspots: `swap/use-swap.ts` is about 2,180 lines, `pools/pool-create-page.tsx` about 1,045, and `pools/liquidity-page.tsx` about 930. Their size does not justify a transaction rewrite in this stack. Start by removing obsolete paths and separating read/presentation concerns from the existing writes.

## 3. Design rules

- A developer should be able to follow startup → public client → read/write call without tracing several custom providers or factory layers.

- Prefer an explicit `client` parameter to a hidden fallback client constructor.

- Keep application code local to each example. Do not introduce a shared app framework, generic registry engine, or UI package to eliminate small duplication.

- Use existing TanStack primitives, not a new query abstraction over them.

- Keep useful semantic adapters; inline wrappers only when the result is easier to read across their call sites. Moving code to another file is not a reduction in complexity by itself.

- Keep one source of truth for fetched data. Derive presentation state where possible; retain state that records an actual user choice or historical fact.

- Preserve current transaction evidence, account locks, batch fallback behavior, and same-height snapshot checks. Never clear saved operations as cleanup.

- Do not hand-prune generated exports or the public surface of individual shadcn components. Remove a whole unused artifact/component only after checking its generator and all consumers.

## 4. Application setup and RPC configuration

### 4.1 One browser path, one server upstream

All three browsers should call the same-origin `/groundhog-rpc` endpoint. Node scripts and server indexers should receive their upstream URL explicitly.

For swap and launchpad:

- Remove `resolveReadRpcUrl` and browser-side loopback inference once callers use the explicit browser endpoint. Resolve the relative URL against browser origin once during bootstrap, not on every client construction.

- Remove `registryEnabled` from browser config and the obsolete `VITE_POOL_REGISTRY_ENABLED` / `VITE_TOKEN_REGISTRY_ENABLED` surface. Registry APIs are part of these apps, not an optional supported mode today.

- Keep token discovery's actual optional configuration; it is a separate feature.

- Update the local-integration harness to use the app proxy for browser reads. Direct SDK probes continue to use an explicit node URL.

- Keep server-side URL validation, fixed upstream targets, method restrictions, response limits, and counter's special submission policy.

### 4.2 Runtime public configuration

Add `/api/config` to swap and launchpad through the same handler used in dev and production. Return only public network/contract identities, expected artifact hashes, and optional explorer/cross-app links. Serialize addresses and amounts as strings at the HTTP boundary and parse them once on the browser side.

Keep the upstream RPC URL, signing credentials, database paths, and other server settings out of that response. The browser already knows its proxy endpoint.

After both environments use the endpoint:

- Remove `PRODUCTION_BROWSER_RPC_URL = "https://same-origin.invalid/"` and its Vite substitution.

- Replace environment-to-browser config projection with the runtime response.

- Remove the hashed public-config build manifest and its plugin only after its configuration-consistency role has been replaced by server-owned runtime config.

- Retain artifact hash verification and factory/network identity checks. If any manifest field protects generated-binding or artifact compatibility rather than environment consistency, retain that check explicitly instead of deleting it.

- Keep existing environment names initially where possible; avoid combining this change with a wholesale deployment-variable rename. Document which settings are now server-only and require restart/page reload rather than a frontend rebuild.

Primary files: both apps' `src/config.ts`, `src/main.tsx`, `src/app.tsx`, `src/groundhog/client.ts`, `vite.config.ts`, `server/config.ts`, `server/http.ts`, `server/main.ts`, and `server/public-config-manifest.ts`; their setup scripts, `.env.example`, README, and production acceptance helpers.

### 4.3 A small provider composition

Target two production entry modules for wallet integration:

- `app-providers.tsx`: Query provider and official Groundhog wallet provider.

- `wallet-controls.tsx`: connection controls and installation guidance.

Initialize config/client at the app bootstrap boundary, with loading/error/retry feedback. Keep the SDK client stable for the page/configuration lifetime; do not recreate it when a wallet connects or an account changes. Prefer a short bootstrap over caching the SDK object as a normal query and nesting several runtime wrappers.

Remove `WalletWriteContext` and `useWalletWriteBoundary`:

- Launchpad constructs its transaction adapter at route/workflow composition and uses the existing writer prop.

- Swap uses a small app transaction-composition hook, or explicit writer props where already present. This composes `useClient()` and `useWalletClient()`; it does not reimplement wallet state or transaction lifecycle.

- Keep gas/artifact policy and the existing write boundary in `transactions/`.

- Move launchpad's last workflow account state to its workflow route. That state survives disconnect; current authorization continues to come from the library.

- Apply swap's binding-reset key to write forms/workspaces, rather than the whole route tree. Preserve the current reset behavior for those forms, including a new binding for the same account.

Public directory search, sorting, and pagination should survive wallet connection changes. Account-specific balances and “My Tokens” queries must remain isolated. Do not introduce another context just to recreate the removed one under a new name.

## 5. Swap simplification

### 5.1 Remove obsolete single-request scaffolding

Concrete targets:

- Remove `hasLegacyOutstandingRequest()` and the effectively constant `collectionReady` state/gating in `swap/use-swap.ts`.

- Replace the misleading `migrateRequestCollection()` path with one clearly named current-collection load/refresh path. Preserve any lock-sensitive behavior that is actually needed; remove the redundant load immediately after the locked load.

- Remove unused v2 `loadAccountOutstandingRequests`, `loadOutstandingRequest`, `saveOutstandingRequest`, and `clearOutstandingRequest` plus their private serialization helpers and obsolete unit tests. The only external callers found for the latter three are in their storage unit tests; swap-flow tests define similarly named local helpers that already use the v4 collection.

- Remove subscriptions to obsolete v2 keys after verifying that no current code writes them. Keep cross-tab subscriptions to current requests, liquidity, creation, crank, and allowance state, including `localStorage.clear()` events.

- Retain the live request shape and account lock currently housed in `outstanding-request.ts`; relocate them to the current request model and a clearly named account-lock module before removing the obsolete storage module.

- Preserve the current v4 keys and active record formats. This is code deletion, not a storage migration or permission to delete users' saved data.

This is the narrow exception to deferring transaction work: remove demonstrably obsolete scaffolding, while leaving submission, observation, and recovery semantics unchanged.

### 5.2 One initialized client through the read path

Remove `deferClient`/its `Proxy` and eventually the synchronous `createReadClient` API. Make read helpers accept the initialized client explicitly, including snapshot, pool resolution, registry enrichment, token preview, and observer construction. Supply it at the app or script entrypoint.

Where a function now takes several optional injected dependencies and an explicit `undefined` placeholder, prefer a small named input object with required client and real read inputs. Keep useful test seams; do not turn every helper into an interface/factory pair solely for mocking.

Relevant files: `src/groundhog/client.ts`, `swap/snapshot.ts`, `pools/pool-context.ts`, `pools/pool-creation.ts`, `pools/token-preview.ts`, `registry/pools.ts`, and callers constructing transaction observers/executors.

### 5.3 Replace read scheduling, not coherent readers

- Wrap the whole snapshot reader in one TanStack query. Key it by client/network, account, and pool identity. Preserve returned-height checks, grouped retries, stale-data display, refresh errors, and visible polling.

- Keep execution-time fresh reads independent of display-cache freshness.

- Replace `PoolRoute`'s manual loading/error effect with a pool-resolution query.

- Replace token preview's keyed result/attempt state with a query; preserve the wrong-network feedback and review gating.

- Replace token discovery's result/attempt/active-request bookkeeping with a query enabled only while the picker is open. Keep one short debounce and the current keyboard/focus/manual-address behavior.

- Replace directory page/status request schedulers with explicit queries. Keep registry pages separate from live pool enrichment. Preserve `asOfBlock` across pagination, reset it for new filters/explicit refresh, and retain useful data when background reads fail.

- Do not turn each read within a coherent snapshot into an independent query. Keep pool-enrichment concurrency bounded: each pool causes many contract reads, unlike launchpad's single balance read per card.

### 5.4 Reduce presentation and adapter overhead

After removing read scheduling, extract a small number of meaningful presentation sections from the large pool pages where they are independently understandable or repeated. Keep writes with their existing workflow logic. Avoid a generic “workflow page” component with dozens of flags.

Review `contracts/*-adapter.ts` and `*-target.ts`: keep aggregation, returned-height handling, gas choices, and error interpretation; remove interfaces/types or wrappers that only restate a generated binding with no useful policy. For example, `handler-adapter.ts` currently repeats a `PoolState` shape as well as mapping it. Prefer deriving types from generated output where that keeps the consuming code clear.

Delete the unused DevWallet binding and `specs/dev_wallet.spec.xdr`, together with their checksum and generation step in `scripts/generate-contract-bindings.sh`.

## 6. Token launchpad simplification

### 6.1 Directory and card data

- Replace manual page/status polling in `tokens/use-token-directory.ts` with TanStack queries. Keep search debounce and pagination state local and explicit.

- Remove the separate `tokens` state; derive metadata from the fetched page.

- Keep public “All Tokens” metadata independent of wallet identity. Only the creator-filtered query and balance queries depend on the selected account.

- Move the directory-only `CreatedToken` shape out of `contracts/launchpad-client.ts` into the existing registry mapping module, or consume `RegistryToken` directly if that is simpler. Avoid two competing models that need synchronization.

- Keep independent per-card `useTokenBalance` queries, their explicit refresh settings, and post-launch invalidation from #104.

- Centralize the registry freshness flow: one status poller, explicit refresh, and the existing commit-time sync hint. Do not add a second timer or blindly refetch registry metadata whenever a balance changes.

### 6.2 Workflow UI and flags

- Remove the never-disabled `writesSupported` prop, its forwarding, and the unreachable unsupported-writes panel. Keep `connected`, validation, loading, and actual wallet capability checks because they have distinct meanings.

- Remove unused route-level writer injection if all real tests inject at the workflow boundary instead. Keep the workflow's explicit writer input.

- Limit account-keyed remounting to the creation workflow and creator-specific views, rather than keying the entire `LaunchpadRoutes` tree.

- Use the existing presentation helpers consistently for button labels and workflow-derived UI. Do not introduce another status state machine in components.

- Keep `parseTokenDraft` as UI policy for now. Generic amount conversion and any generated validation support will come from the later SDK work, not a new local utility library in this PR.

Primary files: `src/app.tsx`, `routes.tsx`, `launch/create-page.tsx`, `launch/review-card.tsx`, `launch/use-launch.ts`, `launch/presentation.ts`, `tokens/use-token-directory.ts`, `tokens/tokens-page.tsx`, and `registry/tokens.ts`.

## 7. Counter: keep the simple architecture

Counter already uses runtime configuration and shares its API handler between Vite and the production server. Use it as the pattern for the other apps.

Concrete cleanup:

- Keep `isSmashKey` private to `keyboard-pad.tsx`; it has no external consumer.

- Use ordinary `Math.random()` for the non-security-sensitive demo choice of increment/decrement. Keep cryptographic randomness for keys and transaction identities.

- Remove unnecessary exports such as engine-local types after confirming test references; do not remove the implementations merely because they are not imported.

- Remove the retired `COUNTER_DEVELOPMENT_PRIVATE_KEY` migration-only branch and its obsolete diagnostic test, while still requiring the server-only `COUNTER_SIGNING_PRIVATE_KEY`. Never restore the old browser signer path.

- Use the current SDK's parsing/byte helpers where they remove manual conversion glue in `src/groundhog/client.ts`, `server/transactions.ts`, and provisioning.

- Review duplicated HTTP-error extraction in `use-counter.ts` and `topup-signer.tsx`; share a tiny helper only if it reduces the total code and preserves the different response validation. Do not add a request framework.

- Clarify stale deployment documentation after checking whether the per-app Railway configuration is still used. A “legacy” comment alone is not evidence that the file can be deleted.

Keep the worker, transaction engine, separate submission/observation limits, backpressure, and signer-balance readiness in their existing ownership. Do not add React Query or the React wallet package to counter, duplicate its balance polling, or replace its scheduler in this stack. Keep its existing throughput-oriented cadence and the server's signed-transaction allowlist.

## 8. Server, configuration, and setup cleanup

### One handler per concern within each app

Extract/reuse the existing app RPC handler from both `vite.config.ts` and the production HTTP server. Counter's `createApiHandler` demonstrates the desired development/production reuse. Keep static-file serving separate from API handling where that makes the request path clearer.

Consolidate repeated DTO/type definitions and primitive parsers within each app: public config, registry wire shapes, canonical addresses/hashes, and pagination. Browser-shared modules must stay free of Node imports. Keep validation at external boundaries; remove repeated representations and conversions, not evidence checks.

Retain separate swap and launchpad indexers/stores. They look similar but differ in retention-gap handling, source-lag handling, and integrity rules. A generic registry engine would add policy switches and is outside this simplification.

Review network-check ownership without weakening it. Launchpad currently checks network identity before every non-network RPC request and some workflows also check explicitly. Collapse only demonstrably redundant checks inside an already validated operation. Do not substitute cached startup metadata for current network verification or add a custom freshness/TTL protocol before the SDK work.

### Setup and deployment

Update setup outputs and README commands alongside the runtime-config change. Remove dead flags and unused binding generation, but keep contract provisioning steps readable and app-specific. Avoid replacing three clear scripts with a generic deployment engine.

Keep app-specific environment names compatible where practical. This cleanup does not rotate keys, migrate/delete databases, redeploy contracts, or replace deployed artifacts. The existing package-read CI permission blocker is an admin prerequisite, not something to bypass in application code.

## 9. Dead-code review rules and concrete candidates

High-confidence removals: unused DevWallet generation/artifact; no-op legacy request scaffolding; unused v2 request persistence functions; constant launchpad `writesSupported` plumbing; unsupported registry-off branches after routing changes.

Localize rather than delete: `isZeroAddress`, `renderEnvironment`, `loadAccountAllowanceRecords`, `pruneRequestHistory`, internal error classes, and engine-local types. These have live internal uses despite unused-export reports.

Retain: generated contract exports, used shadcn module APIs, CSS state variants, worker entrypoints, and e2e helpers started through subprocess paths. Keep live compatibility for saved launch workflows without batch metadata and allowance records without terminal block evidence. These are not the no-op migration above.

For each deletion, check imports, internal references, package commands, generation scripts, subprocess paths, and tests. Delete tests that only exercise a removed implementation; retain coverage for the behavior that replaces it. Do not use tree-shaking or an unused-export report as proof of dead runtime code.

## 10. Implementation phases and review points

| Phase                      | Changes                                                                                                           | Acceptance before committing                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Proven cleanup          | Dead DevWallet generation, unnecessary exports, constant flags, narrow legacy request cleanup                     | Current storage still loads; no data deletion; codegen scripts have no obsolete references; affected tests/types pass                |
| 2. Runtime config and RPC  | Same-origin browser RPC; runtime config for swap/launchpad; shared dev/prod handler; remove obsolete config paths | Fresh startup/retry works in dev and production; upstream stays server-side; network/factory/artifact checks still reject mismatches |
| 3. Wallet composition      | Remove write context; simplify providers; move workflow account state; narrow remount boundaries                  | Public filters survive connect/disconnect; launch draft recovery and swap signing-binding resets remain correct                      |
| 4. Query/state reduction   | Directory/status queries, grouped pool query, preview/discovery queries, derived metadata                         | Same-height consistency, pagination snapshots, account isolation, stale-data/error display, and visibility behavior hold             |
| 5. Readability and counter | Useful page/adapter cleanup, counter's small changes, remaining script/docs cleanup                               | No extra framework/dependency; counter input/backpressure/top-up behavior unchanged; overall production code/concept count reduced   |
| 6. Final stack review      | Review diff against #104, full checks, PR description and review loop                                             | Green CI and no remaining review findings; review score tracked in PR description                                                    |

Keep phases independently reviewable and commit each after its checks. Within the query phase, complete launchpad first, then swap. Do not mechanically reformat large unrelated files or mix generated binding changes with application cleanup.

## 11. Verification and definition of done

Adapt existing tests rather than recreate the SDK's suite. Focus new coverage on changed boundaries: runtime config delivery, dev/prod proxy parity, query keys and pagination, stale-response isolation, and preserved workflow scoping.

Use the established commands:

- `npm run typecheck`

- `npm test`

- `npm run build --workspaces -- --mode test`

- `npm run test:browser`

- Provisioned production build/start checks for runtime configuration and artifacts before declaring the configuration migration complete. The test-mode bundle alone does not verify the production server path.

- Existing counter acceptance where local CLI/devnode prerequisites are available; do not create new throughput benchmarking machinery.

Success means:

- One understandable bootstrap and browser RPC path per app.

- No custom wallet-state context, fake synchronous client, or unused binding build.

- Fewer manual request schedulers and duplicate copies of fetched state.

- Public browsing is not reset by unrelated wallet events.

- Current recovery, persistence, batch behavior, and coherent reads still work.

- Counter remains a small worker-based example with no new framework dependency.

- Actual net production-code reduction, excluding generated code and deleted tests; report it after implementation rather than promising an arbitrary line target.

## 12. Approval focus

Please review these scope choices in particular:

1. Approved: adopt runtime public config for swap/launchpad now, including replacement of the build-time environment manifest, while preserving artifact/ABI compatibility checks.

2. Approved: keep the examples self-contained rather than create a cross-app shared framework.

3. Approved: include only proven legacy transaction scaffolding removal; leave live transaction lifecycle and generic amount utilities to the upcoming SDK releases.

All three scope choices were approved in Roughdraft. Implementation follows the six phases above on the stacked branch.
