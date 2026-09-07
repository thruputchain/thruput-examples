# Token Launchpad and AMM Swap Integration

Status: Implemented and verified; see the [acceptance record](2026-09-06-cross-app-acceptance.md)
Date: 2026-09-06
Branch: `feat/integrate-amm-swap`
Source baseline: `76ea6cc8be3d920bf573e82ae6d2a5402d5fd890` (branch HEAD equals local `main`; clean worktree before this specification)

## Outcome

Add searchable token address comboboxes to Swap's pool-creation form, optional one-token or two-token URL presets with live metadata previews, and a **Create AMM Pool** link after a verified token launch. Indexed tokens are suggestions, not an allowlist. Users must still be able to enter any compatible, nonzero token contract address, including a token that has not reached the indexer.

Keep the two apps independently deployable. Reuse the launchpad's existing token API through a fixed, same-origin Swap proxy. Do not replicate its SQLite database, import its application configuration, introduce a shared package, or replace the existing transaction workflow. Production stays read-only.

The specification and each implementation phase have separate commits.

## Source Findings

| Current source | Consequence for this change |
| --- | --- |
| `apps/swap/src/app.tsx`, `AmmRoutes` | `/` redirects to `/pools`; `/pools/new` owns creation and redirects to `/pools` in read-only production. Keep these routes and guards. |
| `apps/swap/src/pools/pool-create-page.tsx` | Two raw token inputs; `readCreationState` restores the newest recoverable workflow for the current factory. Preserve recovery, reservations, allowance cleanup, account locks, and explicit review. |
| `apps/swap/src/pools/pool-creation.ts`, `preparePoolCreation` | Already validates distinct nonzero addresses, orders tokens and amounts, fetches coherent live metadata/balances/allowances/funding, rejects existing pools, and checks initial liquidity. It remains authoritative. |
| `apps/swap/src/contracts/erc20-adapter.ts`, `src/groundhog/client.ts` | Existing metadata views and abort-aware RPC transport can power previews without a new token SDK. Browser read-client construction does not currently explicitly bind the configured network. |
| `apps/token-launchpad/server/http.ts`, `parseTokenQuery` | `GET /api/tokens` accepts `q`, `creator`, `sort`, `limit`, `offset`, `asOfBlock`; `GET /api/registry/status` provides network and factory identity even for an empty index. |
| `apps/token-launchpad/server/store.ts`, `queryTokens` | `q` searches normalized name, symbol, token address, and creator address with literal SQL wildcard handling. Preserve these semantics. |
| `apps/token-launchpad/server/domain.ts` | Every token row carries network, factory, and token-code hash; status has network and factory but no code hash. Token pages have snapshot pagination but no top-level scope. |
| `apps/token-launchpad/src/registry/client.ts` | Shows bounded JSON, scope, row, and pagination validation patterns. Reuse the approach, not the whole client or launchpad `AppConfig`. |
| `apps/token-launchpad/src/app.tsx`, launch success actions | `creation.status === "committed"` can coexist with incomplete verification. The new CTA needs the stronger complete-verification gate. |
| `apps/token-launchpad/src/launch/verification.ts` | Existing verification checks receipt/event evidence and live metadata, supply, and holder balance. Do not weaken or duplicate it. |
| Both `server/http.ts`, `server/public-config-manifest.ts`, `vite.config.ts` | Production uses `connect-src 'self'`, read-only RPC allowlists, explicit browser env exposure, and build/runtime manifest checks. New integration settings must follow these boundaries. |
| Both `package.json` and `scripts/test-clean-ledger.sh` | Apps have separate dependency trees and clean-ledger harnesses. Swap uses client/protocol 0.6.0/0.11.0; launchpad uses 0.4.0/0.8.0. Cross-app acceptance must exercise actual compatibility, not assume it. |

## Optional Configuration

All new integrations default off. URL presets and manual-address metadata previews work without token discovery or launchpad configuration.

| App | Setting | Meaning |
| --- | --- | --- |
| Swap | `VITE_TOKEN_DISCOVERY_ENABLED` | Optional boolean; absent or `false` disables remote suggestions. Only explicit `true` enables them. |
| Swap | `TOKEN_DISCOVERY_UPSTREAM_ORIGIN` | Server-only fixed origin of the launchpad registry HTTP service, required when discovery is enabled. Never expose it through Vite, the public manifest, responses, or browser bundles. |
| Swap | `VITE_STANDARD_TOKEN_FACTORY_ADDRESS` | Expected launchpad token factory, required only when discovery is enabled. Distinct from `VITE_SWAP_FACTORY_ADDRESS`. |
| Swap | `VITE_STANDARD_TOKEN_HASH` | Expected standard-token code hash, required only when discovery is enabled. Reuse the launchpad setting's name and encoding. |
| Launchpad | `VITE_SWAP_APP_URL` | Optional root-origin URL for the Swap app. Absent or blank hides the CTA. |

The token identity scope is only `{ networkId, factoryAddress, tokenCodeHash }`. Take network identity from the existing `VITE_GROUNDHOG_NETWORK_ID`; do not add another network setting. Canonical network IDs are 64 lowercase hex digits without `0x`; canonical addresses and code hashes use `0x` plus 64 lowercase hex digits. Normalize supported configuration encodings at load time and reject zero factory addresses. No launchpad wallet, native-token cost, token-list seed, or second RPC configuration belongs in Swap's discovery client. Factory/hash scope applies only to indexed suggestions, never to arbitrary manually entered tokens.

Validate nonempty optional values rather than silently accepting mistakes. Enabled discovery with missing or invalid origin/factory/hash fails development configuration and production startup/build validation. Disabled discovery needs none of these values, makes no upstream requests, and exposes no active proxy route. Valid but unused settings may remain configured while the feature is off; they must not turn it on implicitly.

Both origin settings accept absolute HTTPS URLs or HTTP on exact loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) for local development. Accept an absent path or `/`, normalize to the URL origin, and reject credentials, other schemes, protocol-relative URLs, non-root paths, query strings, fragments, and path tricks that normalize to root. Do not accept arbitrary base paths, link templates, per-request origins, or embedded API keys. Operators must configure the launchpad and target Swap deployment for the same network; a URL alone cannot authenticate the remote deployment's network.

Extend explicit Vite env exposure only for the new public settings. Extend each app's exact public manifest schema and runtime comparison with its public settings, normalized consistently. Encode disabled/absent optionals explicitly (boolean string and empty optional strings) and adjust validation only for those keys; preserve existing required-field rules. Require a rebuilt bundle when upgrading the manifest schema, not a legacy-manifest fallback. The upstream origin remains runtime/server configuration, not a new public digest or secret field. Build and runtime must agree about discovery enabled state and public scope. Deployment health must not depend on an optional upstream being reachable.

## Same-Origin Discovery Proxy

Add one Swap-local handler, used by `vite.config.ts` development/preview middleware and `server/http.ts` production routing. Keep its small config and wire types inside Swap. Do not import launchpad runtime modules across dependency trees, create a gateway service, or refactor both HTTP stacks into a generic framework.

The browser calls only `GET /api/token-discovery?q=<query>`. Support no other discovery routes. When enabled, the handler makes these fixed upstream calls:

1. `GET <configured-origin>/api/registry/status` to validate network/factory and discover an integrity fault even when the token index is empty.
2. `GET <configured-origin>/api/tokens?q=<query>&sort=newest&limit=20&offset=0` after valid status. Omit `q` when empty.

The client cannot choose the upstream URL, path, HTTP method, creator filter, page size, offset, or sort. Construct the two URLs from the validated origin and literal paths; never append an incoming request target to an origin. Do not proxy sync, writes, RPC, assets, arbitrary `/api/*`, or redirects. Existing Swap pool API routes remain unchanged.

### Search Semantics

Use the existing upstream `q` behavior unchanged. Searching name, symbol, or token address works; creator-address matches are also intentionally returned. Explain this in helper text: "Search name, symbol, token address, or creator address." No new search mode is needed.

Do not partially filter the first 20 upstream matches in the browser, including via Command's default filtering. Such filtering would misrepresent server search and could hide matching tokens outside the first page. Keep the server order. If `hasMore`, say "Showing the newest 20 matches. Refine your search." No pagination, infinite scrolling, or full-index download in this combobox. If `historyLimited`, disclose that only retained indexed history is searchable. An empty result means no indexed match, not that an address is invalid or a contract is absent.

### Validation and Bounds

- Accept only GET with an empty body and exact route. Reject unsupported methods with 405, invalid queries with 400, and disabled/unknown routes with 404. Do not fall through to the SPA for malformed discovery paths.
- Reject repeated `q`, unknown keys, malformed escaping, encoded path separators, traversal, absolute request targets, and request targets over 2,048 UTF-8 bytes. Trim `q` and bound it to 100 UTF-8 bytes, matching the upstream API; do not silently truncate it or change its search normalization.
- Set a 10-second total upstream deadline covering both calls and their bodies. Abort on client disconnect. Disable redirects, omit credentials, and forward no incoming cookies, authorization, host, origin, or forwarding headers. Send only the necessary JSON Accept header.
- Cap each upstream decoded response at 256,000 bytes before JSON parsing, using both Content-Length checks and streamed byte accounting. Cancel oversized streams, including chunked bodies. Require successful HTTP status and JSON content type. Bound the serialized downstream response to the same size.
- Bound active discovery requests to 16 per Swap process, with no waiting queue. Apply a per-client limit of 60 requests/minute with at most 10,000 tracked clients and a bounded overflow policy. Reuse Swap's existing rate-limiter/IP-trust pattern locally where practical; do not trust arbitrary forwarding headers or add new public tuning settings. Apply the same bounds in Vite and production. Release slots on every exit path.
- Return 429 for rate exhaustion, 503 for capacity or registry integrity fault, and 502 for timeout, upstream failures, invalid content, or scope mismatch. Errors use a small stable `{ error: { code, message } }` envelope, at most 300 UTF-8 bytes per public message. Never reflect raw upstream errors, `lastError`, internal hostnames, URLs, stack traces, or request headers.
- Send `Cache-Control: no-store`, JSON content type, and `nosniff`. Keep production CSP and CORS unchanged; no cross-origin browser fetches or broad CORS headers. Do not forward upstream response headers such as Set-Cookie or Location.

Validate upstream status network/factory against configured scope on every search, including blank queries and empty pages. Reject `integrityFault`; `syncing` or `retrying` may return already indexed suggestions with a freshness notice. Validate every row's exact canonical network, factory, code hash, nonzero token address, creator address, nullable metadata, and bounded block height. Reject the whole page on mismatch or duplicate address rather than dropping individual rows. Do not normalize malformed upstream identities into acceptance.

Validate page size and offset equal 20 and 0, row count <= 20, nonnegative safe-integer total, canonical decimal `asOfBlock`, row block heights <= that snapshot, booleans, and consistency of total/row count/`hasMore`. Limit decimal strings to 100 digits; names to 256 UTF-8 bytes, symbols to 64, and decimals to integers from 0 through 255, matching the existing ERC20 adapter. Nullable names/symbols/decimals remain valid suggestions with address fallbacks. Metadata is untrusted text, never HTML, image URLs, or trusted transaction input.

Return only `{ scope, tokens, hasMore, historyLimited, syncState }`. Each token contains `{ tokenAddress, creatorAddress, name, symbol, decimals }`; scope contains the three identity fields defined above. `historyLimited` is true if either validated upstream response reports limited history; `syncState` comes from status. Browser validation uses the same three-field public scope and validates the projected shapes and bounds. Upstream status cannot attest the code hash on an empty page; no token identity is accepted in that case. For nonempty pages every row must match the configured hash. Do not modify upstream status or fetch extra manifests just to certify an empty list.

This proxy trusts the operator-selected registry's indexing provenance, not arbitrary registries or browser-supplied scope claims. Live metadata and pool review still use Swap's configured chain. No token persistence, response cache, status cache, polling loop, or replicated index is added; two bounded reads per debounced search are sufficient.

## Token Address Comboboxes

Replace only the Token A and Token B address controls in `PoolCreatePage`. Use one reusable Swap-local `TokenAddressCombobox` twice, preserving labels, amounts, existing layout, and review actions. Compose the installed Radix-style shadcn Popover with shadcn Command and the existing input/field primitives. Add only missing primitives/dependencies and lockfile changes; do not change the `radix-nova` preset or add a second primitive library. Consult the matching upstream component docs during implementation.

- Keep the canonical selected address separate from the popover's search text. Searching for a symbol is not an address change until an option is selected. The selected address remains visibly separate while searching; explicitly clearing/editing that address clears the old selection and preview, so incomplete address input cannot silently reuse a prior token.
- On opening, request the newest indexed suggestions with an empty query. Debounce nonempty search by 250 ms. Cancel superseded requests and ignore late results using request identity. Keep at most one active search per mounted control, with no background polling.
- Display name, symbol, and a distinguishable address for each option, with the full address available for inspection. Show a clear selected state. Disable Command's local filtering so server matches, including creator matches, survive unchanged.
- A syntactically valid nonzero address always offers "Use address", even with no index match, disabled discovery, API errors, or indexing lag. Selecting a suggestion and using an arbitrary address enter the same live-metadata path. Never require index membership or expected standard-token code hash for manual addresses.
- The other field's selected address may remain visible but must be disabled as a duplicate choice with an explanation. Manual duplicates also produce a field error; do not silently swap or overwrite tokens.
- Include explicit loading, no matches, unavailable/retry, and disabled-discovery states. API failure must not remove a selected address or prevent manual entry. Failed results are not reused as current suggestions.
- Support label association, keyboard search/arrow navigation/Enter/Escape, visible focus, focus return, selected-option semantics, and polite loading/error announcements. Preserve touch usability and prevent long addresses from widening the viewport at 320 px. Use existing semantic colors and components.

## URL Contract and Initialization

`VITE_SWAP_APP_URL` is a root origin, for example `https://swap.example.com`, not a pool-creation path. The only generated launch link is `<origin>/pools/new?tokenA=<canonical-created-address>`. A manually shared two-token link is `<origin>/pools/new?tokenA=<address>&tokenB=<address>`. Both parameter names are case-sensitive.

Only `/pools/new` consumes these presets. Do not add a root query router, route aliases, path-based tokens for creation, `network`, metadata, amount, auto-submit, callback, or return-URL parameters. Existing detail/swap routes and the root redirect remain unchanged. Ignore unrelated query keys without fetching URLs or executing actions from them.

Parse the initial search string once for a new creation-page mount. Query parameters seed form state only; do not call `history.pushState`, `history.replaceState`, `setSearchParams`, or navigate merely to normalize/persist form edits. Closing a combobox, editing fields, refreshing metadata, and clearing a preset never write the URL. Existing application navigation and production guards are not form-state URL writes.

| Input | Required behavior |
| --- | --- |
| Neither parameter | Existing empty creation form. |
| Only valid `tokenA` | Populate A; leave B and both amounts empty. |
| Only valid `tokenB` | Populate B in its own slot; leave A and amounts empty. |
| Two distinct valid values | Preserve A/B order in the form; canonical pool ordering belongs to review. Fetch both previews independently. |
| Mixed-case hexadecimal | Accept lowercase `0x` prefix plus 64 hex digits; canonicalize hex digits in form state only. |
| Empty, zero, malformed, or repeated value for a key | Reject that slot, leave it empty, show a bounded preset warning, and make no metadata call for it. Keep an independently valid other slot. Even identical repeated values are invalid. |
| A and B normalize to the same address | Keep A, leave B empty with a duplicate warning; fetch A once. |
| Query changes while the form remains mounted | Do not overwrite edits, restart recovery, or reapply presets. A fresh navigation/remount may seed a new form. |

Recovery takes priority over every preset. Run existing storage loading first. If a recoverable workflow is selected, preserve its pair, amounts, transactions, and selection logic; do not seed or fetch URL tokens in the background. Say that a saved creation is being recovered and link presets were not applied. After recovery is archived/reset, start with the existing empty-form behavior, not a delayed URL replay. Keep obsolete-factory warnings and account-wide blocking behavior. If storage cannot be read safely, show the existing error, do not use presets as a workaround, and do not enable new signing. User edits then take priority over all later asynchronous results.

## Live Metadata and Review

Before displaying token metadata as live, explicitly verify the RPC network identity against the configured 32-byte network hash, not a display name, RPC URL, protocol string, or registry status. Use the current client's network-bound cluster support and `getNetworkInfo()` check, following `server/chain.ts`; no second RPC endpoint or SDK is required. Perform this check for each new preview batch/retry and before authoritative review. Never rely only on the client's default cluster inference. A mismatch fails closed for previews and new review/signing; suggestions or a syntactically valid address cannot override it. Keep existing recovery evidence and observation available rather than clearing stored workflows.

For each valid selected/preset address, fetch name, symbol, and decimals through `createErc20ReadAdapter(...).metadata()` and the existing abort-aware read client. No amounts, wallet secrets, balances, or allowances are needed for this preview. Show address plus live name/symbol/decimals when available, and distinct pending/unavailable states before then. Missing name/symbol use the existing review-style address fallbacks; missing/unsupported decimals are not invented. A failed preview keeps the address editable and provides Retry; it never substitutes indexed metadata as a successful live read.

Key results by network, relevant caller configuration, token address, and request generation. Abort on unmount/address or configuration change, clear stale preview immediately, and ignore stale resolutions even when cancellation races. Editing a token clears that slot's amount and invalidates any old review; editing an amount also invalidates review. Do not let an in-flight review for old input become actionable after an edit. Loading a second token must not replace the first token's successful preview.

Preview is informational, not an approval or a coherent pool snapshot. Users must still enter both amounts and press the existing Review action. `preparePoolCreation` must reread live state, perform existing coherent-height retries and checks, and remain the sole producer of the executable creation review. A transient preview failure need not forbid an explicit fresh Review attempt; network mismatch and invalid/duplicate input do. No cached decimals may determine amounts, no preview may submit or sign, and no URL may skip review. Preserve existing checks for pool existence, funding, reservations, minimum liquidity, balances, approvals, execution, and post-creation verification.

## Verified Launch CTA

Add **Create AMM Pool** alongside existing launch success navigation, using a normal anchor composed with the existing shadcn Button. Show it only when the optional Swap origin is configured, `workflow.creation.status === "committed"`, `workflow.verification.status === "complete"`, and `workflow.createdAddressHex` is a valid nonzero address from that verified workflow. Use the created address, never a prediction, form input, registry search result, or transaction hash. Preserve launch recovery scope checks.

Build the link with `new URL("/pools/new", validatedOrigin)` and `URLSearchParams`. Include only `tokenA`, canonicalized; never transfer symbol, decimals, supply, wallet/persona, amounts, signatures, or keys. Navigate in the same tab only on click. No auto-navigation, new network parameter, wallet synchronization, preselected counter-token, or background Swap request is required. A successful launch must not wait for registry indexing to offer the link. Pending/uncertain/failed creation and incomplete verification show no CTA; completing the existing verification retry may reveal it.

## Production Invariants

- Keep both production write boundaries unavailable and development credentials excluded from production/preview bundles. Do not add `groundhog_sendRawTransaction`, signing, funding, or deployment methods to production RPC allowlists.
- Keep `/pools/new` redirected to the read-only pool directory in production, including preset URLs. Production does not mount the creation combobox or perform preset metadata work. Do not introduce a read-only creation page just to display this feature.
- A configured CTA is navigation, not permission to create. When its destination is a read-only deployment, the existing redirect applies. Document that the complete creation journey currently requires loopback development with disposable signing accounts.
- The new production token-discovery endpoint is GET-only, even though its initial UI consumer is development-only. Existing registry sync hints/indexer writes remain unchanged; "read-only" means no chain transaction relay, not removal of existing index maintenance.
- Keep token/pool databases separate and owned by their existing indexers. No migrations, token tables in Swap, or contract changes are required.

## Phased Commits

Each phase must be reviewed and committed separately, staging only its intended files. Do not squash the spec into implementation or amend a previous phase to hide later work. No approval pause is required between the future phases once implementation is requested.

| Phase | Scope | Verification before commit |
| --- | --- | --- |
| 0: Specification (this task) | This file only. | Check against current source, requested behavior, security boundaries, and practical implementation size; inspect diff and whitespace. |
| 1: Configuration and discovery boundary | Optional config, explicit env exposure, both public manifests, one Swap proxy handler wired to Vite/production, bounded wire validation. No combobox yet. | Config/manifest round trips and drift; enabled/disabled cases; proxy behavior, identity, bounds, sanitization, routing, CORS/CSP, cancellation and resource cleanup. |
| 2: Swap inputs and presets | Small combobox, missing shadcn primitives, preset parser, metadata preview, explicit live network validation, creation-page wiring. | Component/parser/RPC tests, races, manual fallback, recovery priority, review invalidation, and production route guards. |
| 3: Launch handoff | Verified-success CTA and link builder, preserving current workflow. | Complete versus incomplete/pending verification, configured/absent origin, created versus predicted address, and exact URL output. |
| 4: Cross-app acceptance and operator docs | Single-ledger cross-app harness, any small prerequisite fixes exposed by real execution, environment examples and both READMEs, test commands and result record. | Full suites/typechecks/builds for both apps, production smoke, and mandatory live cross-app journey when tools are available. Record blockers honestly. |

Keep tests next to the relevant existing tests. Expected touch points are both config/manifest/Vite files; Swap `server/http.ts` and `server/main.ts`; small Swap-local discovery and preset/preview modules; `pool-create-page.tsx`; launchpad success UI; app manifests/lockfiles only for required UI/test tooling; `.env.example`, both READMEs, and integration scripts/tests. Avoid unrelated formatting, generated binding regeneration, dependency alignment, a query-cache framework, or generalized token/URL abstractions. If an actual protocol incompatibility prevents acceptance, fix only the demonstrated prerequisite in a separate clearly described commit rather than assuming broad upgrades are necessary.

## Test Contract

| Layer | Required cases |
| --- | --- |
| Configuration/manifests | Default off; independent integrations; malformed optionals; missing enabled scope; root-origin normalization/rejection; network/hash/address canonicalization; new public fields round-trip; build/runtime drift rejected; missing old-schema fields require rebuild; upstream origin and secrets absent from assets/manifest/errors. |
| Discovery HTTP, Vite and production | Exact two upstream paths and fixed params; no redirects or header forwarding; empty-index wrong-network/factory failure; wrong row hash/network/factory or duplicate row rejects whole page; invalid JSON/content type/page fields; oversize declared/chunked bodies; body/method/query/path rejection; timeout/disconnect; rate/concurrency bounds and slot cleanup; bounded errors; disabled route; unrelated pool APIs unchanged. |
| Search contract | Actual launchpad HTTP/store results for name, symbol, partial/full token address, creator address, Unicode normalization, literal `%`/`_`, newest ordering, more than 20 matches, null metadata, and limited history. No client partial filtering. |
| Combobox | Keyboard/touch/focus, distinguishable duplicate symbols, selected state, loading/empty/error/retry, stale-query race, disabled discovery, valid unindexed manual address, zero/invalid address and duplicate selection, long addresses at mobile width. |
| Presets/metadata | No params, A-only, B-only, two-token, mixed case, empty/malformed/repeated keys, zero, duplicate pair, unrelated keys, no history writes, no auto-review/signing, both live metadata reads, unavailable/nullable metadata, network mismatch, cancellation, caller/network changes, edit versus late response/review. |
| Recovery | Existing current/older/obsolete factory workflows, blocking cleanup, failed funding cleanup recovery, corrupt/unavailable storage, preset ignored during recovery, reset without URL replay, account/persona switch and outstanding-request locks unchanged. |
| Launch handoff | Only committed + complete verification + actual address yields CTA; verification retry reveals it; pending/uncertain/incomplete/failed states and absent config do not; exact destination/query; no sensitive values or predicted address; no indexing dependency. |
| Production | Build and start both real servers, serve SPA/manifests, exercise discovery over Swap origin under existing CSP, verify request sanitization, reject transaction RPC methods, preserve creation-route redirects and absent signing controls/credentials. Vite preview is not a substitute for the production server. |

Run `npm test`, `npm run typecheck`, and `npm run build:production` in each app with controlled fixtures for production env values. Add a dedicated, documented cross-app command (proposed Swap script: `test:e2e:cross-app`) rather than silently extending a test that starts a separate ledger per app. Browser tests can use installed tooling or a minimal dev-only browser runner; do not add browser dependencies to production.

## Live Cross-App Acceptance

This is an implementation acceptance gate, not an action in the spec-only phase. The supplied binaries were checked during research and are executable: Groundhog reports `0.15.1`, hog-devnode reports `0.1.27-rc.1`; Node, npm, flock, and setsid are available. Protocol compatibility and browser tooling still require verification during implementation. Because binaries are available, do not replace the live journey with mocked tests or report an unattempted run as passed.

Use these settings for the new harness:

```bash
GROUNDHOG_CLI="$HOME/Work/groundhog-rpc/target/debug/groundhog" \
GROUNDHOG_DEVNODE_BINARY="$HOME/.local/share/groundhog/hog-devnode/hog-devnode" \
GROUNDHOG_E2E_HOGD_PROTOCOL="hogp/4166df9d6a5411d" \
npm run test:e2e:cross-app
```

Run from `apps/swap` after the command exists. Start one clean loopback ledger with dynamic ports and disposable funded accounts. Provision both factories and apps against that same RPC/network/runtime manifest. Provision sequentially: the apps can use the same disposable account, so concurrent wallet transactions risk nonce conflicts. Use separate temporary registry DBs, CLI/XDG state, and logs. Preserve/restore both `.env.local` files (including symlinks) and existing CLI config if existing setup scripts need them; preferably use temporary output paths. Clean up only harness-owned processes and state on success, failure, and interruption. Do not launch the two existing clean-ledger harnesses independently and call that cross-app acceptance.

1. Start both registry HTTP services and both Vite apps on distinct origins; configure Swap's fixed registry upstream and launchpad's Swap root origin. Verify the actual RPC network hash equals both app configs and the runtime protocol is `hogp/4166df9d6a5411d`. A protocol identifier is not a network hash.
2. Launch a uniquely named token with the real launchpad workflow. Assert committed creation, complete verification, and the actual created address. In a real browser, assert the success CTA href and click it to reach Swap with only `tokenA`. Delay indexing to prove that live preview and manual entry work before search results appear.
3. Verify Swap loads live name/symbol/decimals without altering the URL, leaves B/amounts empty, and does not sign or auto-review. Choose a funded counter-token, enter amounts, explicitly review, create the pool, process initial liquidity using the existing workflow, and verify canonical factory mapping, positive reserves, and LP delivery from live state.
4. Let launchpad indexing catch up. Search through Swap's actual same-origin proxy by unique name, symbol, token address, and creator address; choose the indexed result. Compare with live metadata, not just index labels. Also test a compatible token outside the configured launchpad index by manual address.
5. Open a fresh two-token preset and verify both live previews and preserved form order. Exercise malformed and duplicate presets, recovery taking priority, RPC-network mismatch, registry scope mismatch, and upstream outage with manual fallback. An existing pair must be rejected by authoritative review, not accidentally recreated.
6. Build and start both production servers against the same test ledger with disposable secrets excluded. Verify discovery reads over Swap origin and production route/RPC write restrictions. Do not attempt to enable production signing to complete the journey.

If no browser runner is initially installed, attempt to use/install a minimal local test runner in the implementation phase. A real chain/API run does not prove keyboard behavior or a browser CTA click; record those as separate acceptance results. If tooling, protocol compatibility, or an external dependency blocks a required step, record the exact command, failing boundary, and remaining unverified steps. Resolve feasible blockers; never silently skip or claim complete acceptance.

Document the actual run with tool versions, commands, nonsecret network identity, created token/pool addresses, and pass/fail results in a short acceptance record under `docs/specs`. Do not commit runtime manifests containing disposable private keys, raw env backups, private upstream URLs, or full unredacted logs.

## Spec Review

The design deliberately preserves upstream creator-address search, uses status to reject wrong-scope empty indexes, and treats registry metadata only as discovery hints. It keeps token scope independent of AMM scope, gives saved workflows priority over URL state, and preserves read-only production even when a CTA targets it. The minimal implementation is a Swap-local proxy/client boundary, one reusable input component, a small preset/preview path, and a launch success link; no new database, contract, cross-app package, or cache is needed.

The spec phase used source inspection and document review. Implementation, regression coverage, live cross-app acceptance, and final review corrections are recorded in subsequent commits and the acceptance record.
