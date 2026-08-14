# Groundhog Swap Multi-Request Workflow

Status: Draft

Date: 2026-08-14

## Scope

Extend the swap frontend to let one account enqueue multiple exact-input swaps before an external crank processes them. Preserve the transaction safety, request-ID correlation, and local-development constraints defined in [Groundhog Swap Frontend MVP](./2026-07-30-swap-frontend-mvp.md). This spec replaces only the MVP's one-outstanding-request restriction.

## Contract Semantics

- Treat each quote as an estimate from the latest observed reserves. Do not project reserves from queued requests.
- Preserve `amountOutMin` at submission. The handler recalculates output from live reserves when it dequeues the request and fails the request if the limit is not met.
- Do not promise queue position or execution order for concurrently submitted requests.
- Keep queue processing external through `bash scripts/crank-local.sh`.

## Requirements

### Submission

- Allow another swap after the prior swap is safely submitted, without waiting for execution.
- Permit only one approval or swap submission workflow at a time. Serialize workflows across tabs with the existing Web Lock boundary.
- Prevent duplicate submission and preserve the existing rules for indeterminate outcomes and automatic retries.
- Before enqueueing, reserve the input amounts of all unresolved requests that may still execute. Reject a new swap when its input plus existing reservations exceeds the current balance of that token.
- Ensure the handler allowance covers the new input plus every unresolved request using the same input token. Never reduce allowance below that aggregate exposure.
- Do not count expected outputs from queued requests as spendable balances.

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
- Show the external crank instruction while requests remain queued.
- Let the user dismiss terminal history. Any manual resolution of an untracked request must clearly require confirmation that the relevant queue was externally drained.
- Preserve the MVP's responsive, accessibility, and local-key warning requirements.

## Non-Goals

- Contract changes, cancellation, reprioritization, or an in-app crank.
- Projected quotes, optimistic application of queued swaps, or queue-position estimates.
- Exact-output swaps, routing changes, liquidity management, or arbitrary pools.
- Cross-device or server-backed history.
- Parallel signing or transaction submission from one browser account.

## Testing

- Unit tests cover collection persistence, legacy migration, bounded history, atomic updates, per-token reservations, aggregate allowance targets, and indeterminate requests.
- Observer tests cover multiple successes and failures, same-block terminal events, pagination, deduplication, independent timeouts, and disabled ambiguous snapshot inference.
- Component tests prove that queued requests no longer block the form, reserved balances prevent overcommitment, request statuses update independently, reload recovery works, and terminal history can be dismissed.
- Cross-tab tests prove that concurrent submission attempts serialize without duplicate requests or lost persisted updates.
- A local integration test enqueues at least two swaps before one external crank, observes each terminal event by request ID, and verifies refreshed balances, allowances, and reserves.

## Success Criteria

- A user can enqueue multiple valid swaps before running the crank.
- Each request survives reloads and reaches the correct independent terminal state.
- The app never spends or approves less than unresolved requests require, never treats queued output as available, and never represents a current quote as a guaranteed execution result.
- Existing single-request behavior and safety tests remain valid.
