# Swap App Contract Migration
**Status:** Implemented and verified
**Date:** 2026-09-02
**Target:** `apps/swap`
**Contract baseline:** PR #58, `swap cleanup`
## Summary
Refactor the swap app for the contract topology and interfaces introduced by PR #58. A pool now consists of a liquidity-token contract, a handler, and a driver. The handler owns the embedded pair engine, is the canonical pool address, exposes pool state, and emits terminal events. After receiving a native-HOG allowance from the caller, the factory funds and creates all three contracts atomically. The router only submits requests to existing pools.

This specification replaces the obsolete contract-integration requirements in the existing swap app specifications. Product behavior not addressed here remains unchanged.
## Goals
- Regenerate TypeScript bindings from the merged contract interfaces.

- Replace the deployable pair contract with the handler as the pool identity and read target.

- Update local deployment for the new initialization order and three-contract topology.

- Replace the four-transfer pool creation workflow with one factory-funded, atomic creation request.

- Preserve durable transaction recovery without resuming records created for the old protocol.

- Observe terminal events from the handler with the new payer and recipient semantics.

- Adopt gas-bounded queue processing and the new driver result types.

- Update the UI, tests, and documentation to describe the new protocol accurately.

## Non-goals
- Change swap pricing, slippage, deadline, allowance, or token metadata product behavior except where the new interfaces require it.

- Add user-configurable crank gas limits.

- Predict pool contract addresses before creation.

- Migrate or resume browser records written for the old four-contract topology.

- Preserve support for contracts deployed before PR #58.

## Contract Model
### Pool topology
Each factory pool record contains exactly these addresses:

- `liquidityToken`: LP token contract.

- `handler`: canonical pool address, embedded pair engine owner, state read target, and terminal event emitter.

- `driver`: authorized request queue and processing contract.


The app must not build, deploy, configure, display, persist, or query a standalone `swap-pair` contract. The Rust crate under `engines/swap-pair` is an implementation detail embedded in the handler.

`SwapFactory::get_pair(token_a, token_b)` returns the handler address. The app must use that address for pool identity, route validation, URLs, cache keys, and event filtering.
### Authorization and request flow
The authorization chain is:

1. The router validates that the factory contains the requested pool.

2. The router invokes the pool's driver.

3. The driver invokes its authorized handler.

4. The handler mutates the embedded pair engine and emits terminal events.


The router never creates a missing pool. A missing-pool error is a final failure for add-liquidity, remove-liquidity, and swap submissions.
### Pool creation funding
The factory exposes `pool_funding()` as `{ min, recommended }`. Both values are funding **per child contract**. Because a pool has three contracts, the native-HOG allowance must cover `3 * funding`.

- The UI must fetch this policy before presenting or submitting pool creation.

- The app must pass `recommended` to `create_pair` and approve `3 * recommended` to the factory. Calculate the total with checked arithmetic against the native token's amount range. The app must not use a configured constant or `min`.

- The UI may display both values for diagnostics, but it must describe `recommended` as the amount required by this app.

- A funding amount below `min` is invalid.

- A funding amount at least `min` can still remain pending if it cannot reserve all contracts. This is a platform constraint, so the app avoids it by using `recommended`.

- The app must not expose an arbitrary funding input in this migration.

## Required Changes
### Generated bindings and build scripts
- Remove the `swap-pair` contract artifact and generated TypeScript binding.

- Generate a `swap-handler` binding.

- Regenerate the factory, router, and driver bindings from the merged interfaces.

- Ensure generated factory types include `PoolFunding` and the three-address `Pool` record.

- Ensure generated router results include `SwapDriverError` in the declared error union.

- Ensure generated driver bindings expose the new processing result and summary event.

- Fail binding generation when a required contract artifact is missing; do not retain stale checked-in output as a fallback.

### Runtime configuration
Remove these concepts from `AppConfig`, environment parsing, runtime keys, and validation:

- `pairAddress`.

- A standalone pair contract module.

- `poolContractFunding` or any equivalent hard-coded per-contract funding value.


Global configuration must contain only network, account, router, factory, native-HOG, and known-token values. Resolve handler, driver, liquidity-token, token-pair, and token-metadata values into pool-scoped `AppConfig` at runtime. The handler replaces the old pair address wherever the app needs pool identity.

Name new fields and types after their contract roles. Do not keep a `pairAddress` alias for compatibility.
### Local setup
Update clean-ledger setup to perform this order:

1. Publish the factory, router, handler, driver, liquidity-token, and sample-token modules.

2. Deploy and fund the router contract without initializing it.

3. Deploy and initialize the factory with the router address required by its new ABI.

4. Initialize the deployed router with the factory address required by its ABI.

5. Query `factory.pool_funding()`.

6. Approve `3 * recommended` native HOG to the factory.

7. Call `factory.create_pair(token_a, token_b, recommended)`.

8. Read the created pool record from the factory.

9. Approve the initial token amounts to the handler.

10. Submit initial liquidity through the router.

11. Process the driver queue.

12. Verify the handler's terminal event and `pool_state()`.


The resulting references must satisfy router-to-factory and factory-to-router validation. Scripts must not use predicted pool addresses to pre-fund individual pool contracts.

The setup output must identify the handler as the pool address. The generated `.env` must not require pool-specific addresses because the app resolves them through the factory. Remove pair module and pair contract outputs.
### Factory adapter and pool discovery
Replace the old four-address pool type with the generated three-address factory type. The adapter must:

- Fetch `pool_funding()` with typed decoding.

- Create a pool with both token addresses and the selected funding amount.

- Return or resolve the resulting factory pool record.

- Resolve the canonical handler for a token pair.

- Treat a factory entry as valid only when the handler, driver, and liquidity-token addresses are present and valid.


Pool discovery must use `get_pair()` as the existence check and canonical handler lookup. After confirming existence, it may call `pool_addresses()` to obtain the full three-address record. It must verify that the record's handler equals `get_pair()` before using its driver or liquidity-token address. It must not treat `pool_addresses()` alone as proof that a pool exists.
### Pool state and snapshots
Replace pair-contract reads with `handler.pool_state()`.

The resulting application snapshot must still supply the reserves, LP supply, token identities, and other state required by pricing and liquidity views. Decode reserves, LP supply, the liquidity-token address, timestamp, and cumulative prices from the handler's coherent state response. Derive token identity and canonical order from factory enumeration or the selected token pair; `pool_state()` does not return token addresses.

Snapshot validation must reject:

- A factory record whose canonical handler differs from the selected pool.

- A driver or liquidity-token address that differs from the factory record.

- A handler state whose liquidity-token address differs from the factory record.

- Malformed or incomplete handler state.


Keep existing numeric range and token-order validation.
### Pool creation workflow
Pool creation becomes a distinct transaction before initial liquidity submission.

The creation state machine must represent these durable stages:

1. Loading and validating the factory funding policy.

2. Approving `3 * recommended` native HOG for the factory.

3. Submitting `factory.create_pair(token_a, token_b, recommended)`.

4. Resolving the committed factory pool record.

5. Approving token A and token B for the handler.

6. Submitting initial add-liquidity.

7. Waiting for or processing the driver request.

8. Confirming the handler terminal event and final pool state.


The app must persist transaction identifiers and request IDs before moving to the next stage. On reload, it must reconcile submitted work from receipts, factory state, allowances, handler events, and pool state before it submits another transaction.

The workflow must never repeat a factory creation request merely because its receipt is temporarily unavailable.

Creation races

Another account can create the same unordered token pair after this app starts but before its creation transaction commits.

Recheck factory existence immediately before the funding approval and again before `create_pair`. If the factory already contains the pool, stop creation and load that pool. If approval was already granted, route its unused amount through allowance cleanup.

If a submitted creation loses the race, reconcile the transaction and factory state, mark the creation stage as superseded by the existing pool, and ask the user to continue with initial liquidity. Do not automatically submit liquidity after an ambiguous or failed creation result.

Any unused factory approval must enter the existing allowance-cleanup flow. The UI must state which approval remains and provide the normal recovery action.
### Durable storage policy
Introduce new storage namespaces for every record whose schema or semantics depend on the old pool topology, including:

- Pool creation attempts.

- Swap and liquidity requests that persist a pair address or old event target.

- Allowance evidence and cleanup records tied to the old creation stages.

- Crank attempts whose compatibility path reads `pairAddress`.


New account-wide scans must read only the new namespaces. They must not discover, migrate, merge, block on, or delete old records. Old records may remain inert in browser storage.

New records must persist the handler as `poolAddress` or `handlerAddress`, as appropriate. Do not write a field named `pairAddress`.
### Request observation
Observe successful terminal swap, mint, and burn events from the handler address returned by the factory. Observe `RequestFailed` from that pool's driver as the failure terminal for a queued request.

Correlate each terminal event by `requestId` before applying semantic checks. Use the new fields as follows:

- `sender` is the payer, trader, or redeemer that submitted the economic action.

- `recipient` is the explicit output or liquidity recipient.

- The handler address is the event emitter and must not be inferred from `sender`.


Retain transaction, account, token, amount, deadline, and slippage checks that remain valid. Update event guards and generated event names to match the merged ABI exactly.

Do not accept a successful terminal event from a driver, router, obsolete pair address, or unrelated handler even when its request ID matches. Accept `RequestFailed` only from the factory-recorded driver and correlate it by request ID.
### Queue processing
Keep the app's current fixed process gas limit of `10_000_000` for this migration. Put the value in one named configuration or adapter constant rather than duplicating it.

The driver determines processing capacity from the caller-provided gas limit. The app must:

- Decode typed driver failures, including `SwapDriverError` propagated through router operations.

- Decode `RequestsProcessed` as a summary of the processing call.

- Avoid assuming that one process call drains the queue.

- Refresh tracked request and event state after each committed process call.

- Allow another process attempt while locally tracked eligible requests remain unresolved.


Do not estimate or display a fixed requests-per-call count.
### UI and copy
- Refer to the handler as the pool address in pool directory and detail views.

- Display the handler, driver, and liquidity-token addresses where contract details are shown.

- Remove standalone pair address and pair module labels.

- Split pool creation progress from initial-liquidity progress.

- Explain the factory funding approval and the recommended amount before signature.

- Preserve actionable messaging for signing, indeterminate transactions, request expiry, allowance cleanup, queue processing, and terminal failures.

- Map the new typed contract errors to specific user-facing messages; reserve generic messages for transport or undecodable failures.

## Error Handling
Adapters must preserve generated error discriminants rather than collapsing them into strings. Application error mapping must distinguish at least:

- Pool already exists.

- Pool does not exist.

- Invalid token pair or identical tokens.

- Insufficient factory funding.

- Funding or allowance failure.

- Router validation failure.

- Driver authorization or processing failure.

- Handler request failure.

- Indeterminate transaction submission.


An indeterminate write blocks automatic retry until reconciliation proves that the transaction did not commit. Reads may retry through the existing bounded retry behavior.
## Testing
### Unit tests
Add or update tests for:

- Three-address factory pool decoding and handler identity.

- `PoolFunding` decoding, `recommended` selection, and checked `3 * recommended` allowance calculation.

- Handler `pool_state()` snapshot decoding and validation.

- Removal of all standalone pair binding and configuration assumptions.

- New creation stages, reload recovery, and idempotent reconciliation.

- Pre-submission and post-submission creation races.

- Cleanup of an unused factory approval.

- New storage namespaces ignoring old records.

- Handler event filtering by emitter and request ID.

- Payer and recipient event semantics for swap, mint, and burn.

- Typed router and driver error mapping.

- Repeated gas-bounded processing and `RequestsProcessed` decoding.

### Integration tests
The generated-binding integration suite must exercise the merged descriptors, not test doubles shaped like the old ABI. Cover:

- Factory funding policy reads.

- Atomic pool creation.

- Factory pool lookup by token pair and handler.

- Initial liquidity submission only after creation.

- Swap and liquidity terminal events emitted by the handler.

- Multiple process calls when one gas-bounded call leaves work queued.

### Clean-ledger acceptance
Update `scripts/test-clean-ledger.sh` and local helpers to prove this sequence from an empty ledger:

1. Build and publish without a deployable swap-pair artifact.

2. Initialize router and factory with reciprocal references.

3. Query recommended pool funding and approve three times that amount.

4. Create a three-contract pool atomically.

5. Discover the handler as the canonical pool.

6. Add initial liquidity and process it.

7. Read reserves and LP supply from handler state.

8. Submit and process a swap.

9. Submit and process a liquidity removal.

10. Verify each terminal event's handler emitter, request ID, sender, and recipient.

11. Verify app reload recovery at each durable transaction boundary.

## Documentation
Update `apps/swap/README.md`, setup instructions, environment examples, and operational troubleshooting to match the new topology and funding workflow. Remove commands and explanations for a deployable pair contract.

Document that:

- The handler is the pool.

- Pool creation and initial liquidity are separate operations.

- The app uses factory-recommended funding.

- Processing capacity depends on transaction gas and may require repeated crank calls.

- Browser records from pre-migration deployments are intentionally ignored.

## Acceptance Criteria
- `apps/swap` contains no runtime import, generated binding, configuration field, or deployment step for a standalone swap-pair contract.

- A clean binding generation produces handler, factory, router, driver, liquidity-token, and token descriptors required by the app.

- Local setup succeeds from an empty ledger using the required router/factory initialization relationship.

- Pool creation approves `3 * recommended` native HOG once and performs one atomic factory request with `recommended` as the per-contract funding argument.

- Initial liquidity is never submitted before the factory confirms the pool record.

- Pool directory, details, snapshots, and transaction storage consistently use the handler as pool identity.

- Swap, mint, and burn completion is accepted only from the correct handler and correlated by request ID.

- Queue processing handles partial progress without assuming the queue drained.

- Old four-contract workflow records cannot block or resume the new app.

- Unit, integration, production build, lint, and clean-ledger acceptance checks pass.
