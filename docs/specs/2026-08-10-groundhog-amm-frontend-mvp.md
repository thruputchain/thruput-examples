# Groundhog AMM Frontend MVP

Status: Draft

Date: 2026-08-10

## 1. Scope

Expand `apps/swap` into **Groundhog AMM**, one internal local-development app for discovering, creating, selecting, and swapping through Uniswap V2-style pools managed by one configured factory and router.

The integrated MVP must support:

- Listing pools created by the configured factory.
- Creating and seeding a missing pool for two existing ERC20 contracts.
- Selecting a pool through a stable URL.
- Swapping through the selected pool with the existing exact-input workflow.
- Fixed HOG prefunding for new suite contracts (see Section 6 for the recommended funding-quote improvement).
- The current browser-local development signer and external CLI queue processing.

The app introduces no administrator role or allowlist. "Permissionless" describes factory behavior: any funded local user may create a pool.

### Routes

```text
/pools
/pools/new
/pools/:token0/:token1
/pools/:token0/:token1/swap
```

`token0` and `token1` are canonical lowercase token addresses. `/` redirects to `/pools`.

### Success Criteria

- Setup deploys one factory, one router, a funded local account, and example tokens without creating a pool.
- `/pools/new` creates and seeds one missing pool.
- Successful creation redirects to the new pool's detail or swap route.
- `/pools` lists every pool created on the retained local ledger and links to it.
- A user can select any listed pool and complete the existing exact-input swap workflow.
- Pool-specific state, events, transactions, and recovery never leak between routes.
- Canonical ordering works with asymmetric token addresses and amounts.
- Automated tests cover discovery, creation, route selection, dynamic swapping, recovery, and creation races.
- The interface is responsive and accessible on mobile and desktop.

### Non-Goals

- Adding liquidity to or removing liquidity from an existing pool.
- Pool analytics, charts, historical activity, or multi-hop routing.
- Deploying token contracts from the app.
- Configuring factory hashes, `fee_to`, router ownership, or governance.
- An in-app crank or keeper.
- Public networks, production custody, or a production wallet provider.
- An authoritative storage quote, storage refunds, pool closure, or reserve withdrawal in the MVP contracts.

Existing-pool liquidity management is the intended next route:

```text
/pools/:token0/:token1/liquidity
```

It is not part of this MVP.

## 2. User Experience

### Pool List

1. The user opens `/pools`.
2. The app queries `SuiteCreated` events emitted by the configured factory from the beginning of retained local history.
3. The app validates and deduplicates each event, then loads token metadata, reserves, and LP-token details.
4. The page displays token symbols, pair address, reserves, and links to pool details and swap.
5. **Create pool** links to `/pools/new`.

If retained event history does not cover factory creation, the page reports that discovery is incomplete. It must not silently present a partial registry as complete.

### Create And Seed Pool

1. The user enters two ERC20 addresses and initial token amounts.
2. The app validates addresses, metadata, decimals, balances, amount ranges, and canonical ordering.
3. `factory.get_pair(token0, token1)` must return `None`.
4. `factory.predict_pair(token0, token1)` returns the LP token, pair, handler, and driver addresses.
5. The review screen shows token details, initial ratio, predicted suite, exact approvals, and fixed HOG prefunding.
6. The user confirms **Create & seed pool**.
7. The app serially funds the four predicted addresses.
8. The app sets both handler allowances to the exact reviewed amounts.
9. The app refreshes and revalidates all reviewed state.
10. The app submits `router.add_liquidity` with canonical amount arrays and the local account as LP recipient.
11. A matching `SuiteCreated` proves deployment; `RequestAccepted` proves liquidity enqueueing.
12. The developer cranks the predicted driver externally.
13. A matching `MintEvent` and LP balance delta prove initial liquidity execution.
14. The app redirects to `/pools/:token0/:token1` or its `/swap` child route.

Creation requires five to seven transactions: four HOG transfers, zero to two allowance adjustments, and one router transaction. Cleanup may require up to two additional allowance adjustments after a race or failure.

### Select And Swap

1. The user follows a pool link to `/pools/:token0/:token1/swap`.
2. The app validates the route addresses and canonical order.
3. It calls `factory.get_pair` and `factory.predict_pair`, requiring the registered pair to match the predicted suite.
4. It builds a dynamic pool context containing token metadata, pair, LP token, handler, driver, balances, allowances, and reserves.
5. It renders the existing swap workflow using that context.
6. Swap approval, enqueueing, external crank, event observation, timeout, recovery, and balance refresh retain the requirements in `docs/specs/2026-07-30-swap-frontend-mvp.md`.

## 3. Product Requirements

### Pool Discovery

- Use factory `SuiteCreated` events as the MVP discovery index.
- Require the configured factory as event emitter.
- Validate canonical token topics, suite fields, pair count, payload shape, and event identity.
- Query in ascending order, follow cursors, and deduplicate by `(txHash, sequenceNumber)`.
- Hydrate each pool with typed token metadata and pair reserve views.
- Link by canonical token addresses, not pair address alone.
- Show loading, empty-factory, unavailable-history, malformed-event, and RPC failure states.
- Provide manual refresh.

The current factory registry exposes pair addresses but not their token addresses or full suites, and the pair does not expose `token0` or `token1`. Event-based discovery is acceptable for a fresh internal ledger. A future durable registry API should return `(token0, token1, Suite)` by index.

### Dynamic Pool Context

- Treat RPC, network, wallet, native HOG, factory, and router as global configuration.
- Derive token and suite configuration from the selected route.
- Require `get_pair(token0, token1)` to equal `predict_pair(token0, token1).pair`.
- Reject missing, noncanonical, identical, zero, or malformed route addresses.
- Key snapshots, event filters, durable requests, pair workflow locks, and observation locks by network, account, factory, and canonical pair.
- Reset pool-specific UI state when navigating to another pair.
- Never reuse a reader, observer, signer target, or persisted workflow created for another pool.

### Initial Liquidity Validation

- Parse amounts with `bigint`; token amounts must fit `u128` and allowance adjustments must fit signed `i128`.
- Require positive balances and amounts for both tokens.
- Require `floor(sqrt(amount0 * amount1)) > 1_000`. The pair permanently locks 1,000 LP base units from the first mint.
- Preserve the user's visual token order but orient all factory, router, pair, amount-array, and event operations to canonical order.
- Use desired amounts as initial minimum amounts so execution cannot silently seed fewer tokens than reviewed.
- Display the initial ratio without implying an external market price.

### Fixed Prefunding

- Configure one `VITE_POOL_CONTRACT_FUNDING` value in raw HOG units.
- Transfer it once to each predicted LP token, pair, handler, and driver address.
- Label it **Fixed development storage reserve**, not a fee, estimate, or exact quote.
- Show all destinations and the four-address total before confirmation.
- Do not imply that unused HOG will be refunded.
- Persist each destination, canonical hash, signed envelope, expiry, and outcome.
- Never replace an unresolved transfer with a newly signed transaction.
- Developer setup funds the factory and router. Individual creators do not reimburse factory registry growth; Section 6 records this limitation.

### Approvals And Authorization Limitation

- Approve the predicted handler, not the router or pair.
- Set each allowance to the exact reviewed amount with `adjust_allowance(handler, desired - current)`.
- Permit reducing excess allowance; do not offer unlimited approval.
- Observe both committed allowance values before router submission.
- Offer exact allowance cleanup after a pre-submission race, authoritative router failure before enqueueing, or terminal `RequestFailed`.
- Once `RequestAccepted` proves liquidity is queued, preserve both allowances until `MintEvent`, `RequestFailed`, or authoritative queue consumption. Early cleanup would force the accepted request to fail.

The current driver accepts a purchaser supplied by the request. Exact allowances limit exposure but do not prevent another caller from submitting a request against them. The MVP is restricted to trusted local participants until contract authorization is strengthened.

### Creation Events And Race

- Recheck `get_pair` and `predict_pair` immediately before submission.
- Require exactly one matching `RequestAccepted` emitted by the predicted driver.
- Require exactly one matching `SuiteCreated` emitted by the configured factory before claiming this transaction created the pool.
- Validate `SuiteCreated` token topics and suite fields against the reviewed prediction.
- Persist the request ID from `RequestAccepted`.
- If `SuiteCreated` is absent, report a creation race and preserve the request for observation. Do not claim pool creation.

Another user may create the same canonical pool after this app checks availability or after this user funds its addresses. Committed prefunding benefits the canonical suite regardless of who creates it. The app must preserve and explain that funding and stop if the final check finds a pool. It may clean up approvals only when no request was accepted; an accepted request retains its allowances until terminal resolution.

The final check cannot remove the race between checking and router execution. Another creator may enqueue liquidity first and establish another ratio, causing this app's exact-minimum request to fail. A future create-only router entrypoint should abort when the pair already exists.

### Queue Observation

- Keep queue processing external and document a crank command for the selected pool's driver.
- Match `MintEvent` by request ID, pair emitter, handler sender, and positive LP amount.
- Verify the recipient through the reviewed request and LP balance delta because `MintEvent` has no recipient field.
- Treat `RequestFailed` as terminal and offer allowance cleanup.
- Advance the two-minute observation timeout only while the page is visible, persist elapsed time, and resume after reload.
- On timeout, remain queued; event absence does not prove failure.

### Durable Transactions

Use one shared transaction coordinator for creation and swapping, with separate workflow definitions.

- Persist one creation attempt per network, account, factory, and canonical pair.
- Persist swap requests under the selected pair as required by the existing swap specification.
- Save each canonical hash, exact signed envelope, and expiry before submission.
- Serialize wallet signing and signed-transaction recovery across every pool with one network/account-scoped Web Lock.
- Use separate pair-scoped locks for workflow mutation, event observation, and clearing. Web Locks support is required.
- Resubmit only the same signed bytes. Do not replace a transaction until it is authoritatively invalid or the observed chain tip has passed its expiry.
- Continue to the next stage only after committed success and refreshed state.
- Never continue automatically after the page unmounts or route changes.

Outcome terms remain consistent across workflows:

- **Pre-submission failure:** no signed transaction may have reached the RPC; a new attempt is safe.
- **Authoritative invalid:** the RPC proves the transaction cannot commit; a new attempt is safe after refresh.
- **Committed success or failure:** a matching receipt proves inclusion and its execution result.
- **Indeterminate:** pending, unknown, timeout, recent conflict, disconnect, or any result that does not prove safety to retry.

### Interface And Accessibility

- Use one app shell with navigation for **Pools**, **Create pool**, and the selected pool.
- Pool detail shows token metadata, reserves, LP token, pair, handler, and driver.
- Pool detail provides a clear **Swap** action and reserves space for future liquidity management.
- Creation shows prediction, prefunding, approvals, durable progress, recovery actions, and crank instructions.
- Preserve keyboard access, visible focus, accessible names, non-color status, 44px touch targets, and reduced-motion support.
- Use polite live regions for meaningful progress and assertive alerts only for actionable failures or indeterminate outcomes.

## 4. Technical Requirements

### Application Architecture

- Continue using `apps/swap`; do not create a second frontend.
- Add URL-addressable pool list, creation, detail, and swap routes.
- Keep the existing swap workflow as a pool-parameterized feature rather than a global fixed-pair page.
- Replace fixed pool environment configuration with a dynamic `PoolContext` derived from canonical route tokens and factory validation.
- Share focused RPC, wallet, transaction-outcome, persistence, amount, token-ordering, and event utilities.
- Keep creation, swap, and future liquidity workflows separate. Do not combine them into one state machine or page component.
- Do not duplicate the existing swap page to create pool-specific variants.

### Global Configuration

```text
VITE_GROUNDHOG_RPC_URL
VITE_GROUNDHOG_NETWORK_ID
VITE_GROUNDHOG_WALLET_ADDRESS
VITE_GROUNDHOG_WALLET_ENTRYPOINT
VITE_NATIVE_HOG_ADDRESS
VITE_SWAP_FACTORY_ADDRESS
VITE_SWAP_ROUTER_ADDRESS
VITE_POOL_CONTRACT_FUNDING
GROUNDHOG_DEV_PRIVATE_KEY
```

Remove the selected pair, handler, driver, and token addresses from global runtime configuration after route-based selection is complete.

Vite may define `GROUNDHOG_DEV_PRIVATE_KEY` in browser code only for `vite serve` with a loopback RPC. Build and preview receive `undefined`.

### Bindings And Adapters

- Generate a SwapFactory TypeScript binding for registry views, prediction, creation types, and `SuiteCreated`.
- Generate or validate the devnode native ERC20 v0.1.3 browser binding. Do not assume the checked-in ERC20 v0.1.6 codec is compatible.
- Retain typed router, pair, driver, ERC20, view, and event adapters.
- Validate network identity before views, event queries, transaction observation, or signing.
- Require loopback app, RPC, setup, and crank targets.
- Never hand-code selectors or trust signature-only event matches.

### Pool Discovery Limitation

Before relying on factory index views:

- Fix the `pair_at(index == length)` boundary issue.
- Add a durable contract view such as `suite_at(index) -> Option<(token0, token1, Suite)>`, or add pair token views.

Until then, the internal MVP may use retained `SuiteCreated` events and must disclose unavailable history.

### Setup

Setup must:

1. Validate a fresh loopback development runtime.
2. Build and register LP token, pair, handler, and driver artifacts.
3. Deploy and fund one factory and router.
4. Fund the local account and deploy two or more example ERC20s.
5. Create no pool; creation belongs to `/pools/new` acceptance.
6. Write key-bearing `.env.local` and CLI configuration atomically with mode `0600`.

## 5. Testing

Unit and component tests must cover:

- Factory event pagination, validation, deduplication, and unavailable history.
- Route parsing, canonical pair identity, dynamic suite validation, and navigation between pools.
- Pool-context isolation for readers, writers, observers, persistence, and Web Locks.
- Asymmetric amount orientation, initial ratio, `u128`, `i128`, balance, precision, and minimum-liquidity validation.
- Fixed funding breakdown, exact approvals, cleanup, and durable creation stages.
- Creation races, missing `SuiteCreated`, timeout, and conflicting earlier liquidity.
- Existing swap behavior against at least two dynamically selected pools.
- Route changes during approval, submission, and observation.

Contract tests must prove prediction matches deployment, duplicate creation fails, asymmetric amounts remain correctly oriented, minimum liquidity is enforced, insufficient fixed funding fails, and event emitters and payloads match.

One clean-ledger integration test must execute:

```text
empty pool list -> create and seed pool -> observe MintEvent
-> pool appears in list -> select pool -> quote and submit swap
-> externally process swap -> observe SwapEvent -> refresh state
```

## 6. Storage Funding Decision And Recommended Improvement

### MVP Decision

The MVP follows the current swap setup pattern: transfer one conservative fixed HOG amount to each predicted child address. This is acceptable for a disposable internal example but is not an exact or portable storage quote.

Limitations:

- Every child receives the same amount despite different deployment and state sizes.
- The amount does not derive from the active storage-cost model.
- Excess HOG remains with the contract.
- Funding does not roll back if later creation fails.
- Another user may trigger creation after the addresses are funded.
- The creator does not reimburse factory registry growth.

### Recommended Contract Improvement

The preferred future model is a versioned quote plus an atomic HOG pull. The UI displays the quote, while the contract recomputes it, pulls only the current deficit, and enforces a user-supplied maximum.

Illustrative API, subject to protocol and contract review:

```rust
struct FundingPart {
    address: Address,
    creation_cost: u128,
    operational_reserve: u128,
    existing_credit: u128,
    required_pull: u128,
}

struct PoolCreationQuote {
    version: Hash,
    suite: Suite,
    factory: FundingPart,
    liquidity_token: FundingPart,
    pair: FundingPart,
    handler: FundingPart,
    driver: FundingPart,
    total_pull: u128,
}

fn quote_pair_creation(token_a: Address, token_b: Address)
    -> PoolCreationQuote;

fn create_pair_funded(
    token_a: Address,
    token_b: Address,
    expected_quote_version: Hash,
    maximum_hog: u128,
) -> Suite;
```

The quote should include native balance-row creation, exact artifact deployment, encoded initialization state, factory registry growth, first-liquidity and queue storage when bundled, an explicit operating reserve, and existing HOG credits.

The quote version should bind the storage-cost model, factory implementation, child artifacts and sizes, serialization version, and reserve policy. `maximum_hog` caps payment; it is not the amount pulled.

Open questions:

1. Can contract code read the network's active storage-cost coefficients and model identifier? If not, should each factory deployment pin one cost schedule and be replaced when that schedule changes?
2. Should the quote cover suite creation only or creation plus first liquidity and queue storage?
3. How should the creator reimburse factory registry growth?
4. Can the factory distinguish a missing native balance row from an existing zero balance?
5. What operating reserve should each child retain, and can excess ever be withdrawn?
6. Can native `transfer_from`, funding, deployment, initialization, and registry writes be proven atomic on every failure path?
7. Should the router expose a funded create-only initial-liquidity entrypoint that aborts when the pair exists?
8. How should quote compatibility change with artifacts, serialization, or the network storage model?

The future quote model should replace only fixed prefunding. Discovery, pair validation, prediction, approvals, dynamic pool selection, transaction handling, and request observation should remain stable.

## 7. Decisions And Prerequisites

Decisions:

- One integrated app remains at `apps/swap`.
- The MVP delivers pool list, create-and-seed, pool selection, and dynamic swapping.
- Existing-pool liquidity management follows later.
- Retained factory events provide temporary local pool discovery.
- `SuiteCreated` proves deployment, `RequestAccepted` proves enqueueing, and correlated pair or driver events prove terminal execution.

Before implementation:

- Generate the factory and native HOG bindings.
- Confirm event layouts and asymmetric amount ordering.
- Confirm fixed funding under the pinned local model and artifacts.
- Refactor fixed swap configuration into global app configuration plus dynamic pool context.
- Add setup that deploys infrastructure without creating a pool.
- Define dynamic-driver crank commands.
- Fix or avoid the factory registry and pair-token discovery limitations described above.
