# Groundhog AMM Frontend MVP

Status: Draft

Date: 2026-08-10

## 1. Scope

Expand `apps/swap` into **Groundhog AMM**, one local-development app for listing, creating, viewing, adding liquidity to, and swapping through pools managed by one factory and router.

### Routes

```text
/pools
/pools/new
/pools/:token0/:token1
/pools/:token0/:token1/swap
/pools/:token0/:token1/liquidity
```

`token0` and `token1` are canonical lowercase token addresses. `/` redirects to `/pools`.

The MVP uses the browser-local development signer and external CLI queue processing. Any funded local user may create a pool; the app adds no administrator role or allowlist.

### Non-Goals

- Removing liquidity from an existing pool.
- Pool analytics, charts, historical activity, or multi-hop routing.
- Deploying token contracts from the app.
- Configuring factory hashes, `fee_to`, router ownership, or governance.
- An in-app crank or keeper.
- Public networks, production custody, or a production wallet provider.
- An authoritative storage quote, storage refunds, pool closure, or reserve withdrawal in the MVP contracts.

## 2. Feature Requirements

### Pool List

- Discover pools from the configured factory's retained `SuiteCreated` events.
- Validate the emitter, event identity, token topics, suite, pair count, and payload.
- Read events in ascending order, follow cursors, and deduplicate by `(txHash, sequenceNumber)`.
- Show token metadata, pair address, reserves, and links to detail, swap, liquidity, and pool creation.
- Support manual refresh and clear empty, unavailable, malformed-data, and RPC error states.

If retained event history does not cover factory creation, the page reports that discovery is incomplete. It must not silently present a partial registry as complete.

Event discovery is temporary because current registry views do not expose token addresses or complete suites. A contract-backed registry is deferred.

### Pool Detail

- Validate pool identity before showing transactional actions.
- Show token metadata, reserves and ratio, LP supply, the user's token and LP balances, LP share, and suite addresses.
- Link to swap and add-liquidity workflows.
- Replace displayed data only after a complete refreshed snapshot validates.
- Distinguish missing or invalid pools, empty reserves, stale data, unavailable views, and RPC errors.

### Create And Seed Pool

- Accept two existing ERC20 addresses and positive initial amounts.
- Require `factory.get_pair` to return `None`, then obtain the LP token, pair, handler, and driver from `factory.predict_pair`.
- Require sufficient balances for both tokens.
- Require the fixed HOG prefunding described in Section 6.
- Require `floor(sqrt(amount0 * amount1)) > 1_000`. The pair permanently locks 1,000 LP base units from the first mint.
- Use desired amounts as initial minimum amounts so execution cannot silently seed fewer tokens than reviewed.
- Review token metadata, initial ratio, predicted suite, and exact approvals without describing the ratio as a market price.
- After prefunding and final validation, submit canonical amounts through `router.add_liquidity` with the local account as recipient.
- Redirect to the pool after verified execution.

### Add Liquidity

- Require positive, nonzero reserves and LP supply before quoting an existing-pool addition.
- Let the user enter either token amount and derive the counterpart with the contract's integer quote and rounding behavior.
- Treat desired amounts as maximum contributions; the handler may consume less of one token to match live reserves.
- Estimate LP tokens as the minimum proportional contribution against both reserves and total LP supply.
- Apply slippage to both estimated deposits; each canonical minimum must be positive and no greater than its desired amount.
- Revalidate the snapshot, then submit the desired maxima and minimums through `router.add_liquidity` with the reviewed local account as recipient.
- After verified execution, show actual deposited amounts and LP received, then remove residual allowances.
- Explain that reserve changes before processing may alter deposits or cause failure at the reviewed minimums.

### Swap

Run the existing exact-input workflow from `docs/specs/2026-07-30-swap-frontend-mvp.md` against the validated route-derived pool instead of a globally configured pair.

## 3. Safety And Recovery

### Pool Identity

- Reject missing, malformed, zero, identical, or noncanonical route addresses.
- Require `factory.get_pair(token0, token1)` to match `factory.predict_pair(token0, token1).pair`.
- Preserve the user's display order, but orient contract calls, amount arrays, persistence, and event checks canonically.
- Validate network identity before reads, event queries, observation, or signing.
- Isolate state and operations by network, account, factory, canonical pair, and workflow. Navigation must not continue or reuse work from another route.

### Transactions And Approvals

- Use integer arithmetic. Token amounts must fit `u128`; allowance changes must fit signed `i128`.
- Refresh account, network, suite, balances, allowances, reserves, and LP supply before submission when relevant.
- Approve only the validated handler for exact reviewed amounts; never offer unlimited approval.
- Persist each signed transaction, canonical hash, envelope, and expiry before submission.
- Serialize signing and prevent concurrent mutation or observation of the same workflow.
- Resubmit only the same signed bytes. Replace them only after authoritative invalidity or after the observed chain tip passes their expiry.
- Advance a workflow only after committed success and refreshed state.

After `RequestAccepted`, preserve allowances until `MintEvent`, `RequestFailed`, or authoritative queue consumption. Clean them earlier only when no request was accepted; clean residual allowances after terminal resolution.

The driver accepts a purchaser supplied by the request. Exact allowances reduce exposure but do not prevent another caller from using them, so the MVP assumes trusted local participants.

### Outcomes And Events

- **Pre-submission failure:** no signed transaction may have reached the RPC; retry is safe.
- **Authoritative invalid:** the RPC proves the transaction cannot commit; retry is safe after refresh.
- **Committed:** a matching receipt proves inclusion and its result.
- **Indeterminate:** pending, unknown, timeout, conflict, disconnect, or any outcome that does not prove retry safety.

Persist accepted requests across reloads, route changes, and disconnects, but never continue them under another pool context. A timeout remains indeterminate and does not prove failure.

Claim creation only from `SuiteCreated` emitted by the configured factory and matching the reviewed tokens and predicted suite. Claim enqueueing only from `RequestAccepted` emitted by the predicted driver, and persist its request ID. Correlate terminal events by request ID, validated emitter, sender, pair, and payload. For `MintEvent`, which has no recipient field, also require the reviewed request and LP balance increase. Derive deposited amounts from coherent pre- and post-execution balances and reserves, not preflight estimates. Treat `RequestFailed` as terminal.

Queue processing remains external. Show a crank command for the validated driver.

### Creation Races

Recheck `get_pair` and `predict_pair` before creation. If the pool now exists, stop, explain that committed prefunding benefits its canonical suite, and clean approvals only if no request was accepted. If `SuiteCreated` is absent after submission, report a race, preserve any accepted request, and do not claim creation. Exact initial minimums may cause the request to fail if another request establishes a different ratio.

## 4. Local Environment

Global configuration contains only network, account, native HOG, factory, router, and fixed-funding values; derive pool contracts and tokens from the route.

### Configuration

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

Vite may expose `GROUNDHOG_DEV_PRIVATE_KEY` only during `vite serve` against loopback RPC. Build and preview must receive `undefined`. App, RPC, setup, and crank targets must remain loopback-only.

### Setup

- Validate a fresh loopback runtime.
- Build and register the suite artifacts, then deploy and fund one factory and router.
- Fund the local account and deploy at least two example ERC20s, but create no pool.
- Write key-bearing app and CLI configuration atomically with mode `0600`.

Before implementation, generate the factory binding, validate the native ERC20 v0.1.3 browser codec, confirm event layouts and canonical amount order, verify fixed funding, and define dynamic-driver crank commands.

## 5. Testing And Acceptance

Unit and component tests cover discovery, route and suite validation, pool isolation, pool-detail refresh, integer arithmetic, approvals, event correlation, creation races, add-liquidity quoting, and dynamic swaps against at least two pools. Recovery tests cover indeterminate outcomes, expiry, reloads, navigation, prefunding idempotency, and allowance preservation after `RequestAccepted`.

Contract tests cover prediction and deployment identity, duplicate creation, canonical amount orientation, minimum initial liquidity, existing-pool optimization and minimums, insufficient funding, and event integrity.

One clean-ledger integration test must execute:

```text
empty pool list -> create and seed pool -> observe MintEvent
-> pool appears in list -> open pool detail
-> add existing-pool liquidity -> observe MintEvent
-> quote and submit swap
-> externally process swap -> observe SwapEvent -> refresh state
```

The interface must pass these flows on mobile and desktop with keyboard access, visible focus, accessible names, and non-color status indicators.

## 6. Funding Decision

For the MVP, transfer the configured fixed HOG amount once to each predicted LP token, pair, handler, and driver. Persist each destination's signed envelope, hash, expiry, and outcome so recovery cannot fund it twice. Before confirmation, label the total **Fixed development storage reserve** and show every destination. It is not a fee or exact quote, does not refund excess, does not reimburse factory growth, and is not atomic with creation.

A future contract-generated quote should replace only fixed prefunding. It should use the active storage model, account for existing credit and factory growth, pull only the current deficit, cap payment at a user-approved maximum, and avoid partial funding on failure.

Open decisions:

1. Whether the quote covers suite creation alone or also initial liquidity and queue storage.
2. How quote versions bind the storage model, artifacts, serialization, and reserve policy.
3. How to make funding, deployment, initialization, and registry updates atomic.
