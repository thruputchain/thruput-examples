# Groundhog Swap Multi-Request Workflow

Status: Approved

Date: 2026-08-14

## Scope

Extend the swap frontend to let one account enqueue multiple exact-input swaps before processing the configured driver's queue from the app or the existing shell script. Preserve the transaction safety, request-ID correlation, and local-development constraints defined in [Groundhog Swap Frontend MVP](./2026-07-30-swap-frontend-mvp.md). This spec replaces the MVP's one-outstanding-request restriction and external-only crank workflow.

## Contract Semantics

- Treat each quote as an estimate from the latest observed reserves. Do not project reserves from queued requests.
- Preserve `amountOutMin` at submission. The handler recalculates output from live reserves when it dequeues the request and fails the request if the limit is not met.
- Do not promise queue position or execution order for concurrently submitted requests.
- Keep `bash scripts/crank-local.sh` as a supported queue-processing fallback.
- Treat `process_requests()` as a driver-wide operation. It may process requests that the current browser did not submit or persist locally.

## Requirements

### Submission

- Allow another swap after the prior swap is safely submitted, without waiting for execution.
- Permit only one approval or swap submission workflow at a time. Serialize workflows across tabs with the existing Web Lock boundary.
- Prevent duplicate submission and preserve the existing rules for indeterminate outcomes and automatic retries.
- Before enqueueing, reserve the input amounts of all unresolved requests that may still execute. Reject a new swap when its input plus existing reservations exceeds the current balance of that token.
- Ensure the handler allowance covers the new input plus every unresolved request using the same input token. Never reduce allowance below that aggregate exposure.
- Do not count expected outputs from queued requests as spendable balances.

### Queue Processing

- Show an in-app **Crank queue** action whenever at least one locally tracked request is queued, queued without an observed terminal event, or queued without a decodable request ID.
- Present the action as processing all requests in the configured transaction queue without showing a local request count.
- Invoke the generated `SwapDriver.processRequests()` target through the existing loopback-only browser write boundary.
- Serialize cranking with approval and swap submission across tabs through the same pair-scoped Web Lock. Re-read local request and crank-attempt state after acquiring the lock and before signing.
- Persist a crank attempt before signing and retain its hash as soon as it is signed. A signed or indeterminate attempt must survive reloads and block another in-app crank until its outcome is resolved authoritatively.
- Never retry an indeterminate crank automatically. Allow an explicit status check through the existing transaction observation boundary.
- On a committed-success receipt, correlate every terminal swap or failure event in that receipt by request ID and apply all matching local results atomically before releasing the lock.
- Continue normal event polling for queued requests not resolved from the crank receipt. A successful crank transaction does not prove that every locally tracked request reached a terminal state.
- Do not change local request status when the crank transaction is invalid, fails before submission, commits unsuccessfully, or remains indeterminate unless an authoritative terminal request event is observed.
- Keep the shell crank command documented as a supported fallback.

### Durable Request State

- Persist each request independently, scoped by network, account, and pair.
- Retain intent, direction, lifecycle status, transaction hash, receipt block, request ID, observation progress, and terminal execution data needed by the UI.
- Include indeterminate swap submissions in balance and allowance reservations because they may have committed.
- Migrate a valid legacy single outstanding request into the new collection without losing recovery state.
- Re-read and update persisted state inside the cross-tab lock to prevent lost updates.
- Keep terminal requests as local history across reloads and cap retained history at the 50 most recent terminal requests. Never evict unresolved requests.

### Observation

- Correlate successful and failed execution by request ID. A terminal event updates only its matching request.
- Observe all unresolved requests, including multiple requests completed in one crank transaction or block.
- Query events from the earliest unresolved receipt block, paginate in ascending order, and deduplicate events. Do not issue one complete event-history scan per request on every poll.
- Track the two-minute visible observation timeout per request. Timeout means execution was not observed; it does not prove failure and must not stop later observation.
- Never attribute aggregate balance, allowance, or reserve changes to one request while multiple requests are unresolved. Snapshot inference may run only when exactly one request can explain the changes.
- Refresh balances, allowances, reserves, and quotes after terminal observations.

### Interface

- Keep the swap form available whenever no approval or submission is active and the unreserved input balance is sufficient.
- Replace the single transaction status with a compact request list showing direction, input, minimum output, status, and actual output when observed.
- Distinguish approving, submitting, indeterminate, queued, execution not observed, executed, and failed states without implying that enqueue means execution.
- Explain that quotes may change before execution and that slippage protection can cause a queued request to fail.
- Show a concise transaction-queue action while requests remain queued.
- Let the user dismiss terminal history. Any manual resolution of an untracked request must clearly require confirmation that the relevant queue was drained.
- Preserve the MVP's responsive, accessibility, and local-key warning requirements.
- Show crank signing, committed, failed, and uncertain states without implying that local history represents the complete driver queue.

## Non-Goals

- Contract changes, cancellation, or reprioritization.
- Projected quotes, optimistic application of queued swaps, or queue-position estimates.
- Exact-output swaps, routing changes, liquidity management, or arbitrary pools.
- Cross-device or server-backed history.
- Parallel signing or transaction submission from one browser account.

## Testing

- Unit tests cover collection persistence, legacy migration, bounded history, atomic updates, per-token reservations, aggregate allowance targets, and indeterminate requests.
- Observer tests cover multiple successes and failures, same-block terminal events, pagination, deduplication, independent timeouts, and disabled ambiguous snapshot inference.
- Component tests prove that queued requests no longer block the form, reserved balances prevent overcommitment, request statuses update independently, reload recovery works, and terminal history can be dismissed.
- Cross-tab tests prove that concurrent submission attempts serialize without duplicate requests or lost persisted updates.
- Component tests cover crank visibility at one or more queued requests, concise queue copy, write serialization, receipt reconciliation, committed failure, and indeterminate recovery.
- Cross-tab tests prove that concurrent crank clicks or a crank and swap submission cannot produce parallel signing or duplicate crank attempts.
- A local integration test enqueues at least two swaps, processes them with the in-app crank through the browser write boundary, observes each terminal event by request ID, and verifies refreshed balances, allowances, and reserves. The shell crank remains covered as a supported fallback.

## Success Criteria

- A user can enqueue multiple valid swaps before running the crank.
- Each request survives reloads and reaches the correct independent terminal state.
- The app never spends or approves less than unresolved requests require, never treats queued output as available, and never represents a current quote as a guaranteed execution result.
- Existing single-request behavior and safety tests remain valid.
- A user can process the configured driver's queue from the app whenever at least one local request needs processing, recover an uncertain crank safely, and still use the shell fallback.
