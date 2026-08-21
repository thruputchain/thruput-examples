# Groundhog Swap Automatic Queue Processing
Status: Draft

Date: 2026-08-21
## Scope
Make queue processing part of the default swap flow so users do not need to understand or manually crank the driver queue. Preserve the current multi-request workflow behind a session-only **Manual queue processing** switch.

This spec supersedes only the default processing mode and post-enqueue interface in [Groundhog Swap Multi-Request Workflow](./2026-08-14-swap-multi-request.md). Its persistence, reservation, correlation, observation, recovery, history, and shell-fallback requirements remain in force.
## Transaction Semantics
- Automatic enqueue and queue processing use two sequential transactions: the router request followed by one `SwapDriver.processRequests()` invocation. Approval may precede them.
  
- `process_requests()` is driver-wide and may process other users' requests.
  
- One crank has a bounded batch budget. Earlier work may consume the batch before the new request executes.
  
- Do not promise queue position, queue length, immediate execution, or inclusion of the new request in the crank batch.
  
- Preserve each request's submitted `amountOutMin`; live execution may fail after reserves change.
  
- Wallet multicall and atomic enqueue-and-crank behavior remain future work.
  
## Requirements
### Processing Modes
- Add the shadcn **Switch** component labeled **Manual queue processing**.
  
- Automatic processing is active on every page load; the switch is off by default.
  
- Keep mode in component state only. Do not persist or synchronize it across tabs.
  
- The mode selected when submission begins governs that submission.
  
- Disable mode changes while approval, submission, cranking, or recovery is active.
  
- Changing modes never signs a transaction or processes existing work.
  
### Automatic Flow
- Run the current approval and router flow while holding the existing network/account/pair-scoped request-collection Web Lock.
  
- Before approval or router signing, re-read durable request and crank state. A signing or indeterminate crank blocks a new automatic swap until recovery resolves it.
  
- After a successful router receipt is durably persisted as `queued` or `queuedUntracked`, invoke the shared queue-processing operation exactly once before releasing the lock.
  
- Persist the queued request before creating the crank attempt. Persist the attempt before signing and its canonical hash through `onSigned` before submission.
  
- Clear the reviewed input after durable enqueue, as in the current flow. Crank outcome never restores or resubmits it.
  
- Keep automatic submission blocked while the crank is signing or indeterminate. Re-enable it after committed success or authoritative failure; do not wait for the request itself to become terminal.
  
- If the crank does not resolve the new request, leave it pending and continue observation without another automatic crank.
  
- A later successful swap may submit one new crank and process earlier queued work.
  
- Do not crank automatically on mount, mode change, committed-router recovery, or merely because queued requests exist.
  
- Every enqueue completed within an uninterrupted automatic flow initiates one crank. A recovered enqueue does not.
  
### Manual Flow
- Manual mode preserves current user behavior: enqueue without automatic cranking, allow multiple valid requests, and show history, transaction identifiers, recovery controls, manual resolution, and **Crank queue**.
  
- Existing reservations, unresolved-request limits, and write serialization remain unchanged.
  
- Internal handlers and presentation may be refactored for reuse.
  
- Turning manual mode off hides the list but preserves all durable state.
  
- Reloading returns to automatic mode without processing requests created in manual mode.
  
### Automatic Presentation
- Hide full history, transaction identifiers, and the normal **Crank queue** action.
  
- Derive compact presentation from existing `WorkflowState`, the newest available durable `RequestRecord`, and global `CrankAttempt`. Do not create or persist another lifecycle model.
  
- Use existing request-list ordering to select the newest available request. Existing bounded-history pruning applies.
  
- Show the latest available terminal request until a newer durable request replaces it.
  
- Present concise request states: **Approving**, **Submitting swap**, **Transaction outcome uncertain**, **Execution pending**, **Executed** with actual output, and **Swap failed**.
  
- Present crank signing, failure, and uncertainty as queue-level status, separate from the request lifecycle.
  
- Announce phase changes once through the existing polite live region; do not announce repeated polls.
  
- If unresolved `queued`, `queuedNotObserved`, or `queuedUntracked` work is hidden behind the compact latest request, show **Queued work available** without a count.
  
- Activating **Queued work available** enables manual mode and reveals the full list.
  
- Keep mode and recovery controls keyboard accessible, semantically labeled, and textually distinguishable without relying on color.
  
- Keep transaction hashes hidden in automatic mode and preserve accessible hash tooltips in manual mode.
  
### Recovery
- Reuse existing request and crank recovery handlers and controls in both modes; do not build a parallel automatic-mode recovery workflow.
  
- Automatic mode may show only the relevant request and current global crank recovery while keeping history hidden.
  
- Preserve explicit status checks for indeterminate approval, router, and crank transactions.
  
- Preserve pre-hash confirmation when no transaction hash was recorded.
  
- Preserve the best-known signed hash when a result is indeterminate; never replace it with `null`.
  
- Never retry an indeterminate transaction automatically.
  
- If a crank fails authoritatively, leave requests queued and expose **Retry queue processing**. Retry submits one crank and never resubmits the swap.
  
- If a request ID cannot be decoded, attempt the one automatic crank and retain the existing queue-drained confirmation path.
  
- Queue-processing failure must not relabel a successfully enqueued request as a failed submission.
  
## Technical Design
- Keep existing request, crank, observer, write-boundary, generated-target, and storage schemas.
  
- Extract the lock-free body of manual cranking into one shared operation that assumes the request-collection lock is held.
  
- Keep manual **Crank queue** as a lock-acquiring wrapper. Call the shared operation directly after durable enqueue in automatic mode; nested lock acquisition would deadlock.
  
- Before crank signing, re-read request and crank state under the lock and refuse duplicate or stale attempts.
  
- Approval or router invalidity, failure, or indeterminacy never starts a crank.
  
- On committed crank success, correlate by request ID and apply all matching local outcomes in one request-collection write.
  
- Persist the crank result after the request write and before releasing the lock. The separate storage keys do not form one atomic storage transaction.
  
- A crank failure leaves requests queued. A crank without the new request's terminal event leaves it pending. Neither condition resubmits the swap.
  
- Continue polling unresolved requests and preserve reservations, allowance coverage, observation timeouts, snapshot-inference restrictions, cross-tab handling, and bounded history while the list is hidden.
  
- Reload after durable enqueue but before crank persistence recovers a queued request without initiating a transaction.
  
- A restored signing or indeterminate crank exposes compact recovery and blocks automatic submission until resolved.
  
## Non-Goals
- Contract or generated-binding changes.
  
- Wallet multicall, transaction batching, or atomic enqueue-and-crank behavior.
  
- Repeated automatic cranking until the request or queue is terminal.
  
- A continuous crank job, keeper, scheduler, or background service.
  
- Automatic cranking on mount, mode change, or reload recovery.
  
- Persisting or synchronizing the processing-mode preference.
  
- Queue position, authoritative queue length, or guaranteed immediate execution.
  
- Cancellation, reprioritization, exact-output swaps, routing changes, or liquidity management.
  
## Testing
Add tests only for behavior introduced by this spec; retain existing request, crank, observer, reservation, recovery, and serialization coverage.

- Automatic mode is the default and hides full history and manual cranking; manual mode restores them and skips automatic cranking.
  
- The switch is disabled during active writes and recovery and resets after remount.
  
- Automatic target order is router then driver, or approval, router, then driver.
  
- The queued request exists before crank creation; the crank attempt exists before signing; its hash exists before submission.
  
- Router non-success never starts a crank.
  
- Crank failure or uncertainty reuses existing recovery, never resubmits the swap, and never retries automatically.
  
- A crank without the latest request's terminal event leaves it pending without another crank.
  
- Mount, mode changes, and committed-router recovery never initiate writes.
  
- Hidden queued work can reveal manual mode without presenting a count.
  
- Adapt one cross-tab test to prove automatic submission serializes with another write.
  
- Add one automatic local integration scenario and retain the existing multi-request manual scenario.
  
## Success Criteria
- A normal automatic swap durably enqueues and submits one queue-processing transaction without a separate user action.
  
- Manual mode preserves multi-request batching and explicit cranking.
  
- Automatic presentation stays compact without hiding required recovery.
  
- Existing request and crank state remain authoritative in both modes.
  
- No automatic path duplicates a swap, retries an indeterminate transaction, clears unresolved exposure, or attributes another request's result to the latest swap.
