# Consistent scaffolding for swap and token launchpad

Status: implemented and locally verified on PR #105 at the user's request. Live-node wallet acceptance remains blocked by the local CLI/devnode protocol mismatch described below.

## Goal

A developer should learn the application structure once, then concentrate on each example's contracts, reads, and transactions. Give swap and token launchpad the same entry points, composition order, and ownership boundaries while keeping each example self-contained.

Success means a reader can open the same five files in either app and answer: how does it start, where do providers live, where is the header, how are routes selected, and where does feature behavior begin? Both apps should also have the same infrastructure organization: differences in their directory trees should reflect what the apps do, rather than different organizational conventions.

## What the code looks like today

| Concern | Swap | Token launchpad | Proposed treatment |
| --- | --- | --- | --- |
| Startup | `main.tsx` loads config and creates a connected read client | Almost identical implementation | Keep this structure; align terminology where the functions have the same role |
| Core providers | Query and wallet providers in `app-providers.tsx` | Same | Preserve stable instances and focus handling |
| Other providers | A second `AppProviders` in `routes.tsx`, imported as `PageProviders` | Tooltip in `app.tsx`; explorer in routes and some feature components | Put application-level provider composition in `app-providers.tsx` |
| Application composition | `App` renders `BrowserConfiguredApp` inside providers/router | `App` renders a banner and `LaunchpadRoutes` | Use the same `App → AppLayout → AppRoutes` structure |
| Header | Normal pages render it through `AmmPage`; placeholders render another copy directly | One `Header` above the route table | One persistent `AppLayout` in each app |
| Wallet controls | `wallet/wallet-controls.tsx` | Identical implementation | Keep the existing direct SDK hooks and matching file path |
| Route behavior | Pool resolution, read-only redirects, binding revisions, swap runtime composition | Retained workflow account, writer composition, token/create routes | Keep behavior specific to each app, under the route boundary |

The startup code and wallet controls already provide a good common pattern. Most work is moving existing responsibilities into predictable places.

## Target structure

Both apps use these entry points:

```text
src/
  main.tsx                 Runtime config/client startup, loading, retry
  app.tsx                  Providers + router + layout + routes
  app-providers.tsx        Application-wide providers and Query lifetime
  app-layout.tsx           Installation banner, header, navigation, wallet controls
  routes.tsx               AppRoutes: URL mapping and feature access/workflow policy
  components/app-header.tsx
  wallet/wallet-controls.tsx
  groundhog/client.ts
  config.ts
  ...feature directories
```

The intended composition in both `app.tsx` files is:

```tsx
<AppProviders client={client} explorerUrl={config.explorerUrl}>
  <BrowserRouter>
    <AppLayout>
      <AppRoutes config={config} />
    </AppLayout>
  </BrowserRouter>
</AppProviders>
```

Use ordinary React children and the existing declarative router. Matching structure does not require a shared package, configuration-driven shell, new context, or router migration.

### 1. Startup and application composition

- Keep async startup, error reporting, and retry in `main.tsx`; config must load and the read client must connect before wallet/query consumers mount.
- Keep `App` as a small composition component accepting config and an initialized client. It does not manage transaction state.
- Give equivalent top-level components the same names: `App`, `AppProviders`, `AppLayout`, and `AppRoutes`.
- Prefer `createReadClient` for the app-wide client factory in both apps, after checking swap's existing client exports and callers. Preserve genuinely different pool/network config types rather than renaming them for symmetry.
- Keep startup-failure UI outside the connected application shell: wallet controls cannot operate before their providers exist.

### 2. One home for application providers

- Extend each existing `app-providers.tsx` to compose Query, the official wallet provider, tooltip, and explorer providers in the same relative order.
- Keep swap's `ProcessingModeProvider` here as an explicit app-specific addition. Its state must survive route navigation as it does today.
- Remove swap's second `AppProviders` from `routes.tsx` and the `PageProviders` alias.
- Move launchpad's route-level explorer provider here. Audit nested explorer providers in `tokens/tokens-page.tsx` and `launch/review-card.tsx`; remove redundant wrappers where they use the same application setting, updating isolated test wrappers accordingly.
- Retain one stable `QueryClient` per mounted app and the existing foreground listener. Route changes and wallet changes must not recreate the client or the wallet provider.
- Keep providers outside the router unless a provider actually needs routing. Layout and navigation sit inside it.

### 3. One persistent layout

Create `app-layout.tsx` in both apps. It owns the outer application surface, installation banner, `AppHeader`, app-specific navigation, and `actions={<WalletControls />}`. Its children are the route content.

`AppLayout` may read `useWallet()` directly to determine navigation visibility and the home link. It does not derive transaction clients, retain workflow identities, or own write-form reset keys.

- Launchpad: move the existing header/navigation from `routes.tsx` and the banner from `app.tsx` into the layout. Preserve its connected/disconnected home-link behavior.
- Swap: move the header/navigation out of `pools/amm-page.tsx` and the banner out of `BrowserConfiguredApp`; remove the header from `PlaceholderPage`.
- All post-startup routes, including loading, missing-pool, error, and connect prompts, render within this same shell. Swap's placeholder screens will now have the normal navigation as well as wallet controls.
- Keep exactly one page-level `<main>` in the route content. `AppLayout` does not add a second `<main>` around existing pages.
- Keep page-specific actions next to page content. The current `AmmPage.actions` slot has no callers passing actions; remove it rather than creating a mechanism for children to control the global header.
- Convert `AmmPage` into a content-only wrapper, named `PoolPage` in `pools/pool-page.tsx`, with title, description, and children. Remove its wallet/nav imports and shell-only `readOnly` prop. Preserve `readOnly` props wherever they still govern feature behavior.
- Keep launchpad's existing page content layout. Feature forms and spacing need not be identical for the application scaffolding to match.

The header will persist across route transitions. Close its mobile navigation on location changes, including browser back/forward and redirects, so persistence does not leave an open menu after navigation. Preserve its existing keyboard handling and focus behavior.

### 4. Clear route and feature boundaries

Use `AppRoutes` as the exported route entry in each app. Keep wallet-derived feature policy within this boundary so it has the same lifetime as today and cannot remount the application shell.

For swap:

- Fold `BrowserConfiguredApp`'s account config and signing-binding revision handling into `AppRoutes`; retain a separate route-table helper only if it remains useful for focused tests.
- Keep `writeRevision` keys on create/swap/liquidity subtrees, never on `AppLayout`, `AppRoutes`, or providers.
- Move the `PoolRoute` component's URL resolution and loading/error handling into `pools/pool-route-view.tsx`. Keep the existing pure parser in `pools/pool-route.ts`; distinct basenames avoid import-resolution ambiguity.
- Move `ConfiguredApp` into `swap/swap-route.tsx` as `SwapRoute`: it composes the snapshot reader, writer, observer, and `SwapPage`. Retain its useful injected dependencies for tests.
- Keep canonical URL redirects, query strings, invalid-route handling, pool/account query keys, and runtime keys intact.

For launchpad:

- Rename `LaunchpadRoutes` to `AppRoutes` and remove its header/provider responsibilities.
- Keep retained workflow identity and writer composition near the route mapping. These are meaningful launchpad behavior, not generic shell state.
- Preserve the create workflow across disconnects and preserve its account-scoped key when switching accounts. Retaining identity must never authorize writes while disconnected.

Avoid extracting each small branch or hook into its own file. Extract where it establishes a useful shell/feature boundary, not to meet a line-count target.

### 5. Consistent directory ownership and file placement

Align the directory structure as well as the entry points. Both examples retain this common organization:

```text
app/
  public/                  Static browser assets
  scripts/                 App-specific development/build tooling
  server/                  HTTP service and registry indexing
  shared/                  Browser/server wire models and shared constants
  src/
    app.tsx
    app-providers.tsx
    app-layout.tsx
    main.tsx
    routes.tsx
    config.ts
    styles.css
    ui-variants.css
    components/            App-wide presentation and UI primitives
    contracts/             Contract bindings and generated code
    groundhog/             Client initialization and chain integration
    lib/                   Small general-purpose utilities
    registry/              Browser-facing registry access
    setup/                 Existing setup/configuration support
    test/                  Shared test fixtures and rendering helpers
    transactions/          Transaction execution, persistence, and recovery
    wallet/                Wallet connection UI and wallet-specific helpers
    ...feature directories
```

Root-level tests remain beside their modules. This is an ownership map, not a requirement for identical file counts. Build outputs, dependencies, and local deployment state (`dist`, `node_modules`, `.groundhog-config`) are not part of the source-structure comparison.

Apply these placement rules:

- Reserve the `src/` root for application composition, routing, application config, styles, and their tests. Move feature logic and general utilities to their owning directories.
- Give equivalent infrastructure modules matching paths and names where their responsibilities actually match. Audit both apps' explorer context/configuration helpers as part of provider consolidation.
- Keep feature-specific UI with its feature; keep reusable presentation in `components/`. Keep chain-aware helpers out of general-purpose `lib/`.
- Keep module tests beside moved source files. Use `test/` for shared test support, not as a new home for every test.
- Update all imports, scripts, test aliases/mocks, and documentation that reference moved paths. Use direct imports rather than adding forwarding modules or barrel files to hide old placement.

Include these concrete files in the placement audit:

| Current file/group | Planned treatment |
| --- | --- |
| Launchpad `src/errors.ts` and its test | Move the general error-formatting utility to `src/lib/errors.ts`, with its test |
| Launchpad `src/runtime.ts` | Replace the vague runtime grouping with ownership-based placement for its amount limit and native-balance item-cost constants; inspect consumers before choosing existing modules or a clearly named constants module |
| Launchpad `src/explorer-config.ts` and its test | Place URL/config helpers with the corresponding infrastructure owner; use the same convention for equivalent swap helpers |
| Launchpad `src/swap-config.ts` and its test | Inspect its handoff/configuration consumers and place it with that responsibility; keep genuinely application-wide config in `config.ts` |
| Swap `src/workflow.ts` and its test | Inspect consumers and move it to the feature or transaction layer that owns the workflow |
| Swap `src/domain/` | Review amounts, tokens, quotes, allowances, exposure, and reservations by responsibility and consumers; move single-feature modules to their feature, retaining a documented shared-domain grouping only where it serves multiple features |

Record the final old-to-new path decisions in this plan during implementation. Moves should clarify ownership without changing behavior. Do not split cohesive modules into many tiny files or turn `lib/` into a miscellaneous domain-code directory.

Preserve meaningful feature directories: swap has `pools/`, `swap/`, and `token-discovery/`; launchpad has `tokens/` and `launch/`. Neither app needs empty counterparts. Retain the existing feature-directory approach rather than introducing a new `features/` hierarchy.

## Behavior to preserve

- Public directory filters and pagination survive wallet connect/disconnect/provider changes while the directory remains mounted. Ordinary navigation away may still unmount a page.
- Swap signing-binding changes reset only the relevant write forms; account-specific reads remain correctly scoped.
- Launchpad retains its draft/workflow across disconnect and reconnect, with existing safeguards for account switches.
- Transaction persistence before broadcast, uncertain-outcome recovery, account locks, batching, and coherent pool snapshots keep their current semantics.
- Installation guidance, provider selection, connection errors, and wallet buttons remain available throughout the connected application shell.
- Explorer links and swap processing-mode preferences behave as before.

## Scope boundaries

This pass covers the frontend scaffolding of swap and token launchpad. Keep both independently runnable and understandable. Leave counter's worker/scheduler architecture, contract code, server/indexer behavior, registry DTOs, transaction protocols, and SDK APIs as they are.

Keep existing feature directories (`pools`, `swap`, `launch`, `tokens`) and the shared transaction layer. Ownership-driven source moves and import updates are in scope, including the directory audit above; transaction semantics and server behavior remain unchanged. No visual redesign or new dependencies are needed.

## Implementation sequence

Original sequencing proposed a fresh branch after #105 merged. The user subsequently requested pushing this work directly to the existing PR; implementation therefore uses `refactor/example-app-simplification` while #105 is open. The four work units are:

1. **Align providers and root composition.** Consolidate providers, align their order and entry-point naming, update test wrappers, and preserve provider lifetime. Run both apps' typechecks and affected wallet/provider tests.
2. **Introduce persistent layouts.** Move banners and headers, convert swap's page wrapper, update placeholder rendering, and cover mobile navigation persistence. Run shell/navigation and wallet-flow tests plus browser acceptance.
3. **Clarify route/feature boundaries.** Relocate swap-specific route composition and remove superseded exports/imports. Run affected route and workflow tests.
4. **Align directory ownership and document the convention.** Complete the root-file and shared-infrastructure audit, make justified source/test moves, and record the final path mapping. Add matching “Application structure” sections to both app READMEs explaining common directory responsibilities and their domain-specific differences. Run final verification and review the two application trees side by side.

Do not keep compatibility exports solely to avoid updating internal tests. Test utilities should compose the production providers/layout when exercising whole-app behavior; isolated transaction/page tests can use only the dependencies they need.

## Verification and acceptance

Extend existing tests where ownership and lifetime change. Focus on behavior rather than assertions about component names or the exact JSX tree:

- Normal pages and loading/error/connect screens each show one header and one wallet control section.
- Navigation changes page content without resetting wallet/query state; the mobile menu closes on route changes and remains keyboard accessible.
- Public browsing state survives wallet changes; swap write forms reset on a new signing binding; launchpad retains its disconnected draft safely.
- Existing canonical redirects, handoff links, query strings, explorer links, processing mode, and route fallback behavior still work.
- Startup failure/retry, provider selection, no-wallet guidance, and wallet connect/disconnect still work at desktop and 320px widths.

Structural acceptance is a review checklist, not a brittle test asserting an exact directory tree:

- The five entry-point files have matching names and responsibilities, and common infrastructure directories have the same ownership rules.
- Every root-level source module is application scaffolding/configuration; feature logic and general utilities have explicit homes.
- Each remaining directory difference has a domain reason documented in the app READMEs; generated/local directories are excluded.
- The placement audit has an explicit move-or-retain decision for each listed file/group, with tests moved alongside source and no stale imports or compatibility wrappers.
- Both examples remain self-contained; no empty matching directories, new shared framework, or unnecessary indirection is introduced.

Final commands:

```bash
npm run typecheck
npm test
npm run build --workspaces
npm run test:browser
```

Use the existing production wallet acceptance harness (`npm run test:wallet`) when its local node/extension prerequisites are available, particularly for navigation and wallet handoffs. Record any environment limitation separately from passing component/browser tests.

The pass is complete when both apps have the same application skeleton and infrastructure organization, pages no longer own global headers, provider and workflow lifetimes remain correct, tests/builds pass, and remaining differences in the directory trees reflect the apps' domains rather than inconsistent conventions.

## Implementation record

Both apps now compose `AppProviders → BrowserRouter → AppLayout → AppRoutes`. Application providers, banners, headers, and explorer contexts have matching homes. The persistent header closes mobile navigation on location-key changes without remounting wallet controls. Startup uses `createReadClient` in both examples.

### Final ownership decisions

| Previous location | Final location / decision |
| --- | --- |
| Swap `routes.tsx` provider wrapper | Consolidated into `app-providers.tsx`; no `PageProviders` alias |
| Swap `BrowserConfiguredApp` | Wallet binding/config logic in `AppRoutes`; `PoolRoutes` remains a directly testable route table |
| Swap `PoolRoute` and route fallback UI | `pools/pool-route-view.tsx`; pure URL parsing remains in `pools/pool-route.ts` |
| Swap `ConfiguredApp` | `swap/swap-route.tsx`, exported as `SwapRoute` |
| Swap `pools/amm-page.tsx` | Content-only `pools/pool-page.tsx`; global header moved to `app-layout.tsx` |
| Launchpad `LaunchpadRoutes` | `AppRoutes`, retaining workflow-account behavior; shell moved to `app-layout.tsx` |
| Launchpad `errors.ts` and test | `lib/errors.ts` and colocated test |
| Both apps' explorer URL parsing | `lib/explorer-url.ts`, using the name `parseExplorerUrl`; existing validation semantics preserved |
| Swap `ConfigurationError` | `lib/errors.ts`; config and explorer validation import it directly |
| Launchpad explorer context inside identifier UI | `components/explorer-context.tsx`, matching swap; providers no longer live in feature pages |
| Launchpad `runtime.ts` amount limit | `shared/amount.ts`, because browser code and the server store both consume it |
| Launchpad `runtime.ts` pinned storage cost | `groundhog/storage-cost.ts`, consumed by config and provisioning |
| Launchpad `swap-config.ts` and test | `launch/swap-config.ts` and colocated test, beside the swap handoff |
| Swap `workflow.ts` and test | `swap/workflow.ts` and colocated test |
| Swap `domain/quote.ts` and test | `swap/quote.ts` and colocated test; only the swap model uses it |
| Swap `domain/amount`, `allowance`, `allowance-exposure`, `reservations`, `tokens` | Retained: pure rules shared across pool/liquidity/swap features and transaction execution; documented in both READMEs |

No cross-app runtime framework or compatibility exports were added. Provider-dependent test fixtures now compose the required providers explicitly. New layout regression tests cover persistent header/wallet DOM, programmatic navigation, history navigation, and Escape focus restoration in both apps.

### Verification results

- Workspace and seed-script typechecks passed.
- All 1,328 Vitest tests passed: counter 47, swap 880, launchpad 362, seed scripts 39. The three process-cleanup tests also passed.
- All three production builds passed.
- Browser acceptance passed in Chromium 152 at desktop and 320px widths, including startup retry, wallet controls, registry browsing, token discovery, and handoff guards.
- `npm run test:wallet` was attempted, but the local node failed before application startup: the supervisor requested `hogp/a6913f07a5a7`, while the installed runtime advertised `hogp/63c9284d8d5727e`. The harness cleaned up successfully. No live signing/transaction acceptance is claimed for this pass.
