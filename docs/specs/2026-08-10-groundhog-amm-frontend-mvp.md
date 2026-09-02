# Groundhog AMM Frontend MVP

Status: Draft

Date: 2026-08-10

Last updated: 2026-08-21

## 1. Scope

Expand `apps/swap` into **Groundhog AMM**, one local-development app for discovering, creating, viewing, and using pools managed by one factory and router.

### Normative Dependencies

This specification extends the current swap app rather than replacing its transaction machinery:

- Exact-input amount parsing, quoting, slippage, wallet submission, transaction outcomes, event decoding, and accessibility inherit from [Groundhog Swap Frontend MVP](./2026-07-30-swap-frontend-mvp.md).
- Durable request collections, unresolved-input reservations, aggregate allowance coverage, observation, bounded history, cross-tab serialization, crank recovery, and the shell fallback inherit from [Groundhog Swap Multi-Request Workflow](./2026-08-14-swap-multi-request.md).
- Default automatic queue processing and session-only manual mode inherit from [Groundhog Swap Automatic Queue Processing](./2026-08-21-swap-automatic-queue-processing.md).
- Client 0.3.0, generated contract descriptors, DevWallet integration, setup transaction construction, and generated-file handling inherit from [Groundhog Swap TypeScript Setup](./2026-08-19-swap-typescript-setup.md).
- Three disposable development accounts and tab-local account switching inherit from [Local Wallet Personas](./2026-08-22-local-wallet-personas.md).

This specification supersedes those documents only for fixed-pair configuration, single-page routing, arbitrary-pool and liquidity-management non-goals, AMM setup topology, and the multi-pool state rules below. It specifically replaces the **Provisioning Workflow** and **Generated Configuration** sections of the TypeScript setup specification and adopts the automatic-processing specification regardless of that document's draft status. For all other conflicts, the narrower or later requirement applies.

### Existing Baseline

Preserve the current app's implemented behavior:

- Multiple independently tracked exact-input requests may remain unresolved.
- Automatic processing is the default on every page load. An uninterrupted successful enqueue submits exactly one separate driver `process_requests()` transaction.
- Session-only **Manual queue processing** preserves request history, batching, **Crank queue**, and explicit recovery controls.
- The shell crank remains a fallback.
- Queue processing is driver-wide, bounded, non-atomic with enqueueing, and does not guarantee that the newest request executes.
- Quotes use observed reserves only. Queued output is never spendable, and submitted minimums do not change.
- Generated TypeScript descriptors provide typed views, invocations, receipt decoding, event filters, and event decoding. Do not restore hand-written selectors or codecs.
- Signed writes persist the canonical hash before submission and never retry an indeterminate transaction automatically.

### Routes

```text
/pools
/pools/new
/pools/:token0/:token1
/pools/:token0/:token1/swap
/pools/:token0/:token1/liquidity
```

`token0` and `token1` are canonical lowercase token addresses. `/` redirects to `/pools`.

The browser can switch among the three configured disposable development wallets. Any funded account may create a pool at the contract level; the UI adds no administrator role or allowlist.

### Terminology

- **Pool:** the LP token, pair, handler, and driver created by the factory for one canonical token pair.
- **Pair:** the `SwapPair` contract within a pool.
- **Pool addresses:** the `Pool` value returned by `factory.pool_addresses`.
- **Driver queue:** one pool driver's request queue.
- **Queue processing:** a separate `SwapDriver.process_requests()` transaction. **Crank** is UI and developer shorthand.
- `process_requests` is the contract method; `processRequests` is the generated TypeScript descriptor.

### Non-Goals

- Pool analytics, charts, historical market activity, or multi-hop routing.
- Exact-output swaps.
- Deploying token contracts from the app.
- Configuring factory hashes, `fee_to`, router ownership, or governance.
- Cancellation, reprioritization, queue position, or authoritative queue length.
- A continuous keeper, scheduler, background crank, repeated automatic cranking, or atomic enqueue-and-crank transaction.
- Public-network custody, arbitrary account import, or a production wallet provider.
- An authoritative storage quote, storage refunds, pool closure, or reserve withdrawal in the MVP contracts.

## 2. Feature Requirements

### Pool List

- Enumerate canonical token pairs through `factory.all_pairs_length` and `factory.pair_at`.
- Resolve each pool through `factory.pool_addresses` and confirm `factory.get_pair` matches its pair address.
- Show token metadata, pair address, coherent reserves, and links to detail, swap, liquidity, and pool creation.
- Support manual refresh and clear loading, empty-registry, invalid-entry, stale-refresh, and RPC-error states.
- Do not let one malformed registry entry misidentify or hide another valid pool.

### Pool Detail

- Validate factory and pool identity before enabling transactional actions.
- Show token metadata, coherent reserves and ratio, LP supply, the account's token and LP balances, LP share, protocol-fee status from `factory.fee_to`, and all pool contract addresses.
- Link to swap and liquidity workflows.
- Replace displayed data only after a complete refreshed snapshot validates at one block height.
- Distinguish missing or invalid pools, empty reserves, stale data, unavailable views, and RPC errors.

### Create And Seed Pool

- Accept two existing ERC20 addresses and positive initial amounts.
- Require `factory.get_pair` to return `None`, then predict the LP token, pair, handler, and driver through `factory.pool_addresses`.
- Require sufficient token balances and the fixed HOG prefunding described in Section 7.
- Require `floor(sqrt(amount0 * amount1)) > 1_000`; the pair permanently locks 1,000 LP base units from the first mint.
- Use desired amounts as initial minimums so execution cannot seed fewer tokens than reviewed.
- Review token metadata, canonical amount orientation, initial ratio, predicted contracts, prefunding destinations, and required approvals without calling the ratio a market price.
- Present one **Create pool** action that sequentially funds the predicted contracts, obtains any required token approvals, submits canonical arrays through `router.add_liquidity`, and starts the default automatic queue-processing attempt.
- Treat those steps as one recoverable user flow, not one atomic transaction. Show the active stage and preserve completed or indeterminate work across reloads.
- Revalidate the pool's absence, predicted contracts, account, network, balances, reservations, and allowances before each relevant signature.
- Treat `PoolCreated`, `RequestAccepted`, and the terminal mint as separate lifecycle evidence.
- Redirect only after verified mint execution and a coherent refreshed pool snapshot.

### Add Liquidity

- Require positive reserves and LP supply before quoting an existing-pool addition.
- Let either token input drive the counterpart with the contract's integer quote and floor rounding.
- Treat desired amounts as maximum contributions; execution may consume less of one token to match live reserves.
- Estimate LP minted as the minimum proportional contribution against both reserves and total LP supply.
- Apply slippage to both estimated deposits. Each canonical minimum must be positive and no greater than its desired amount.
- Revalidate the pool snapshot, protocol-fee status, account, balances, reservations, and allowances immediately before signing.
- Submit canonical desired and minimum arrays through `router.add_liquidity` with the reviewed account as recipient.
- After verified execution, show actual deposits and LP received. Reduce only allowance above remaining unresolved exposure for the same token and handler.
- Explain that reserve changes before processing may alter deposits or cause failure at the reviewed minimums.
- Treat estimated LP output as unprotected because the router accepts no minimum LP amount. Disable addition when protocol fees are enabled until the app can account for fee minting without overstating expected LP.

### Remove Liquidity

- Let the user remove any positive amount up to their unreserved LP balance.
- Provide accessible 25%, 50%, 75%, and 100% controls.
- Estimate canonical outputs with integer floor division against coherent reserves and LP supply.
- Apply slippage to both outputs and require positive minimums.
- Approve the validated handler for the required LP exposure and submit `router.remove_liquidity`.
- Verify execution with a request-correlated `BurnEvent`: use the emitter as the pair identity, validate handler sender and recipient, orient redeemed amounts canonically, and require each redeemed amount to meet its submitted minimum.
- Show actual redeemed amounts after a coherent refresh.
- Disable removal when protocol fees are enabled until the contract uses the same fee-adjusted LP supply for minimum checks and execution.

### Swap

Run the existing exact-input workflow against the validated route-derived pool, handler, and driver instead of globally configured addresses. Preserve unresolved-input reservations, aggregate allowance coverage, independent request-ID correlation, bounded history, default automatic processing, manual batching, and the shell fallback.

Quotes remain based only on observed reserves. Do not project queued swaps into reserves or expected output.

### Queue Processing

The current processing-mode machinery becomes operation-neutral. It applies to initial liquidity, add liquidity, remove liquidity, and swaps:

- Automatic mode submits one processing transaction after every uninterrupted successful router enqueue.
- Automatic mode does not process on mount, mode change, reload recovery, or merely because queued work exists.
- It does not repeat until the new request or queue is terminal.
- Manual mode exposes the full local operation history, transaction identifiers, recovery controls, and **Crank queue**.
- A failed automatic crank exposes **Retry queue processing**, which submits only a crank and never resubmits the router operation.
- Both modes resolve the driver from the validated pool and retain a shell command parameterized by that driver.
- A successful crank may resolve zero, one, or many locally tracked operations. Apply every matching terminal event atomically and leave unmatched requests pending.

Use operation-specific labels and terminal events:

- Swap: `SwapEvent`.
- Initial or subsequent liquidity: `MintEvent`.
- Liquidity removal: `BurnEvent`.
- Any operation: driver `RequestFailed`.

The automatic-processing specification's liquidity-management non-goal limits that document's feature scope; it does not prevent reuse of its processing, locking, persistence, recovery, or presentation model here.

## 3. Safety And Recovery

### Pool Identity

- Reject missing, malformed, zero, identical, or noncanonical pairs. Redirect valid mixed-case addresses to the canonical lowercase route.
- Require `factory.get_pair(token0, token1)` to match `factory.pool_addresses(token0, token1).pair`.
- Preserve the user's chosen display direction, but orient contract arrays, persisted criteria, and event checks canonically.
- Validate configured and connected network identity before reads, event queries, observation, or signing.
- Key route-bound readers, snapshots, forms, and observers by validated pool identity so rapid navigation cannot retain stale state.

### Multi-Pool Durable State

- Persist each router request independently with its operation kind, network, account, factory, canonical pair, pair, handler, driver, recipient, intent, transaction hash, receipt block, request ID, observation progress, and terminal result.
- Scope request and crank records by network, account, factory, canonical pair, and driver. Workflow affects presentation and validation but must not split one driver's underlying queue state.
- Preserve unresolved operations across reloads, disconnects, and route changes. A route may present only its pool, but navigation must not discard, relabel, submit, crank, or manually resolve another pool's work.
- Keep at most 50 terminal history records per account and factory. Never evict unresolved records.
- Preserve the current safety cap of ten execution-exposed operations, but apply it across the account and factory rather than independently per route so total unresolved exposure remains bounded.
- Fail closed on malformed records or records whose factory, pool, driver, handler, recipient, or operation criteria do not match their storage scope.
- Persist pool creation as its own durable workflow before the first signature. Store immutable reviewed tokens and amounts, predicted contracts, aggregate HOG requirement, each destination's pre-sign marker, transaction hash and outcome, approvals, router request, and creation/mint evidence.

### Reservations And Allowances

- Aggregate balance reservations by network, account, and asset across all factories for every unresolved operation that may consume the same token, LP asset, or native HOG, including indeterminate submissions and creation prefunding.
- Do not count expected swap output, future LP tokens, or expected redeemed assets as spendable.
- Aggregate required allowance by account, token, and validated handler. Different pool handlers have independent allowance totals.
- Approve only the validated handler and never offer unlimited approval.
- Never reduce allowance below the aggregate exposure of remaining unresolved operations for that token and handler.
- Disable snapshot inference whenever more than one unresolved operation could explain account, allowance, LP-balance, or reserve changes, including activity in another pool sharing an asset.

### Signing And Transactions

All writes inherit the current wallet, canonical-hash, transaction-outcome, status-observation, and retry rules. Extend them to prefunding, creation, mint, burn, swap, and dynamic-driver processing transactions.

- Use one network/account Web Lock for signing, durable workflow mutations, global exposure limits, history pruning, and reservations across every factory, pool, route, and tab.
- Re-read all durable account-wide reservations and relevant driver state after acquiring the lock and hold it through signed-hash and router-request persistence. Read-only observation may run outside the lock, but applying observations must use it.
- Persist a pre-sign marker and canonical transaction hash through `onSigned` before RPC submission.
- A transaction with a known hash is recovered by observing that hash. Do not create replacement signed bytes after timeout, unknown status, recent conflict, disconnect, or another indeterminate outcome.
- Permit a fresh transaction only after definitive pre-submission failure, authoritative invalidity, or explicit confirmation that a pre-hash transaction was never signed.
- Revalidate account, network, pool identity, balances, allowances, reserves, LP supply, durable reservations, and blocking crank state immediately before each relevant signature.
- Advance a workflow only after committed success and refreshed state.

### Requests And Events

- Persist the accepted request before starting queue processing.
- Treat request ID plus validated emitter as the authoritative lifecycle correlation.
- Validate every operation-specific field the event contains, including emitter, handler sender, recipient, and canonically oriented amounts. Compare decoded amounts with persisted submitted limits where applicable.
- Claim creation only from `PoolCreated` emitted by the configured factory and matching the reviewed tokens and predicted contracts.
- Claim enqueueing only from `RequestAccepted` emitted by the validated driver.
- Treat matching `SwapEvent`, `MintEvent`, or `BurnEvent` as execution evidence and matching `RequestFailed` as failed terminal evidence.
- A matching `MintEvent` makes the driver request terminal, but until it includes the recipient, distinguish execution from recipient verification. Claim delivery only when the reviewed recipient's LP increase is unambiguous; otherwise retain an explicit recipient-unverified result without inferring another operation's result.
- Derive actual balance, reserve, and LP effects from coherent refreshed snapshots rather than preflight estimates.
- A timeout, successful crank, queue-processing count, balance change, or absence of events does not make a tracked request terminal.
- If `RequestAccepted` cannot be decoded, retain the existing explicit queue-drained manual-resolution path.

### Allowance Cleanup

After `RequestAccepted`, preserve token or LP allowance until a matching operation execution event or `RequestFailed` is observed. Queue-processing success alone is insufficient. Cleanup may remove only allowance above the aggregate exposure of all remaining unresolved operations for the same token and handler.

### Creation Races

Recheck `get_pair` and `pool_addresses` before creation. If the pool now exists, stop, explain that committed prefunding benefits its canonical contracts, and reduce approvals only to the exposure still required by unresolved operations. If `PoolCreated` is absent after submission, report a race, preserve any accepted request, and do not claim creation. Exact initial minimums may cause the request to fail if another request establishes a different ratio.

## 4. Contract Integration

### Current APIs

Use the checked-in generated descriptors from the built specifications:

- `SwapFactory.allPairsLength`, `pairAt`, `getPair`, `poolAddresses`, `feeTo`, and `PoolCreated`.
- `SwapRouter.addLiquidity`, `removeLiquidity`, and `swapExactTokensForTokens`.
- `SwapDriver.processRequests`, `RequestAccepted`, and `RequestFailed`.
- `SwapPair.getReserves`, `getLiquidity`, `MintEvent`, `BurnEvent`, and `SwapEvent`.
- ERC20 balance, allowance, adjustment, transfer, total-supply, and metadata descriptors.

The factory result type is `Pool`, not `PoolAddresses`. ABI snake_case becomes camelCase descriptor names, while decoded struct and event fields retain their generated ABI field names.

Use descriptor `.view()`, `.invocation()`, receipt helpers, filters, and decoders. Keep application adapters thin and add strict domain validation around decoded values.

### Remaining Contract Limitations

- `SwapDriver::request` is not router-restricted. The disposable local MVP assumes trusted participants and displays that limitation; do not add a frontend allowlist. Remove the warning after the driver stores and enforces its router.
- `MintEvent` does not include the LP recipient. Until it does, correlate by request ID, validated emitter and handler sender, then require an unambiguous reviewed-recipient LP balance increase before claiming delivery.
- Protocol-fee minting can make add-liquidity LP estimates stale, and remove-liquidity minimum checks use pre-fee LP supply while execution may use post-fee supply. Keep both liquidity writes disabled when `fee_to` is enabled until the frontend can quote additions safely and the remove calculations match.

Regenerate bindings and strengthen contract tests when any ABI changes.

## 5. Local Environment

### Toolchain

Use Node.js 22.12 or newer, Groundhog CLI 0.9.6 or newer, stable RPC wire format `>=3.0.0`, and the exact frontend versions pinned in `apps/swap/package.json`, including `@groundhogchain/client` 0.3.0 and contract packages 0.7.1.

Before AMM implementation, validate that the generated ERC20 transfer descriptor is compatible with the runtime's native HOG contract. Do not retain the obsolete ERC20 v0.1.3 codec assumption.

### Configuration

Vite-exposed browser configuration contains only the network, account, wallet entrypoint, native HOG, factory, router, and fixed-funding values:

```text
VITE_GROUNDHOG_RPC_URL
VITE_GROUNDHOG_NETWORK_ID
VITE_GROUNDHOG_WALLET_ADDRESS
VITE_GROUNDHOG_WALLET_ENTRYPOINT
VITE_NATIVE_HOG_ADDRESS
VITE_SWAP_FACTORY_ADDRESS
VITE_SWAP_ROUTER_ADDRESS
VITE_POOL_CONTRACT_FUNDING
```

Discover pair, LP token, handler, driver, token metadata, and token decimals dynamically. Do not retain fixed-pool environment values.

`GROUNDHOG_DEV_PRIVATE_KEY` is a dev-server-only input. Vite may expose it to application code only during `vite serve` when the configured RPC target is loopback. Build and preview receive `undefined`.

The generated CLI profile stores `SWAP_DRIVER_PROCESS_REQUESTS_ENTRYPOINT`; the browser does not consume it. Setup retains its current ability to target a caller-managed disposable node. A non-loopback browser configuration is read-only because the local signer is unavailable.

### Setup

Inherit the shell entry point, TypeScript provisioner, generated DevWallet binding, client-owned manifest loading, transaction boundary, artifact loading, output permissions, and failure handling from the TypeScript setup specification.

Replace its fixed-pool provisioning and generated configuration with this AMM topology:

1. Build ERC20 and every swap contract artifact and require the checked-in generated descriptors to match their specifications.
2. Deploy and initialize at least three example ERC20s, one factory, and one router.
3. Fund the factory sufficiently for MVP registry growth and fund Alice, Bob, and Carol with native HOG and example tokens.
4. Create and seed one example A/B pool from Alice, who receives its initial LP position without gaining pool ownership or protocol privileges.
5. Write factory-oriented browser and disposable-persona configuration atomically, with `.env.local` last and mode `0600`.
6. Generate a shell crank profile that defaults to Alice and accepts a validated driver address.

Setup remains non-idempotent and does not enforce a fresh ledger. The clean-ledger integration harness owns node lifecycle and acceptance state.

## 6. Testing And Acceptance

### Frontend Tests

Unit and component tests cover:

- Factory discovery, indexed enumeration, canonical route parsing, pool identity, and malformed registry entries.
- Coherent pool-detail snapshots, LP supply and share, stale refreshes, and rapid route changes.
- Integer creation, add-liquidity, remove-liquidity, and slippage calculations.
- Canonical liquidity arrays, amount bounds, approvals, funding totals, and creation races.
- Operation-neutral request persistence, event correlation, queue presentation, automatic processing, manual batching, recovery, and bounded history.
- Account-wide reservations and signing serialization across at least two pools sharing one token.
- Driver-specific crank state and event isolation for simultaneous work in different pools.
- Mobile and desktop layouts, keyboard access, visible focus, accessible names, live announcements, and non-color status indicators.

### Contract Tests

Contract tests cover:

- Multi-pool factory enumeration, prediction and deployment identity, duplicate creation, and `PoolCreated` integrity.
- Canonical amount orientation and minimum initial liquidity.
- Existing-pool add/remove calculations and minimums.
- Request IDs and `MintEvent`, `BurnEvent`, `SwapEvent`, and `RequestFailed` integrity.
- Router-only driver authorization after that contract change lands.
- Fee-on add-liquidity LP issuance after frontend support lands.
- Fee-on remove-liquidity minimum behavior after that contract fix lands.

Native contract suites require `HOGD_FFI_PASSWORD` or a compatible `HOGD_FFI_LIB_DIR`.

### Clean-Ledger Acceptance

One live integration test starts from the AMM setup's seeded A/B pool and executes:

```text
list and open seeded A/B
-> verify Alice owns the initial LP position
-> switch to Carol
-> add liquidity -> automatically process -> observe MintEvent
-> remove liquidity -> automatically process -> observe BurnEvent
-> switch to Bob
-> quote and enqueue swap -> automatically process -> observe SwapEvent
-> refresh reserves, balances, LP supply, requests, and allowances
```

Additional live scenarios must:

- Create A/C and prove A/B and A/C remain isolated while sharing token A reservations.
- In manual mode, enqueue at least two A/B swaps, crank once in-app, and correlate each terminal event independently.
- Leave one request pending when a bounded crank does not process it, without automatic repeated cranking.
- Process a validated dynamic driver through the shell fallback.

## 7. MVP Funding Decision

The configured user creating the pool supplies its native HOG reserve. The MVP does not request or calculate a storage quote. It uses one configured fixed amount for each predicted LP token, pair, handler, and driver address; local setup separately funds the factory for registry growth.

Before confirmation, label the total **Fixed development storage reserve** and show the amount and destination for all four transfers. State that it is a conservative configured amount, not a fee or quote; excess is not refunded; it does not reimburse factory growth; and the transfers are not atomic with pool creation.

One **Create pool** action orchestrates the complete flow:

```text
validate and review
-> transfer fixed HOG to LP token
-> transfer fixed HOG to pair
-> transfer fixed HOG to handler
-> transfer fixed HOG to driver
-> approve initial token amounts as required
-> create the pool and enqueue initial liquidity through the router
-> submit one automatic queue-processing transaction
-> verify creation and mint execution
```

Reserve the aggregate HOG requirement account-wide before the first transfer. Persist the creation workflow before signing and persist each destination's pre-sign marker, canonical hash, and outcome before advancing. Never submit another transfer to a destination while its original outcome is indeterminate.

Because pool addresses are deterministic, committed funding remains at the canonical pool contracts if another user wins a creation race. The app must explain this outcome, stop before another signature, and must not claim pool creation.

Future work may replace fixed prefunding with a factory operation that calculates current deficits, includes factory growth, pulls HOG from the creator up to an approved maximum, and makes funding, deployment, initialization, and registry insertion atomic. Initial liquidity execution would still remain a later driver-processing transaction unless the contract lifecycle also changes.
