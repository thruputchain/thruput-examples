# Wallet transaction batching
Status: Approved specification. Implementation requires separate approval.
## Goal
Reduce wallet approval prompts in Token Launchpad and Swap by combining related contract calls into one DefaultWallet transaction. Keep the existing single-call flow for wallets that do not support batching.

Initial targets, subject to verification on the deployed runtime:

| Workflow | Current maximum prompts | Target prompts |
| --- | ---: | ---: |
| Create one token | 2   | 1   |
| Create a pool and supply initial liquidity | 6   | 2   |
| Swap or change liquidity in an existing pool | Separate approvals, request submission, and queue processing | One approval for allowances and submission, then queue processing if needed |

Existing allowances, existing funding, manual queue processing, and other callers processing the queue can reduce these counts. These are workflow targets, not guarantees for every recovery case.
## Scope and separate work
- SDK work belongs in `groundhog-client-ts`.
  
- Extension and app integration belong in `groundhog-examples`.
  
- The first implementation covers token creation and pool creation with initial liquidity. Reuse the same mechanism for existing-pool swaps and liquidity changes in a later increment of this workstream.
  
- Keep the token completion action-row improvement in its own UI pull request. It does not depend on batching.
  
- Do not add a new relayer, server-side user signing, automatic approval, or a multiple-transaction signing API.
  
- Do not change contract gas calibration as part of this feature. Use the current calibrated limits and verify a suitable batch budget.
  
## Existing support and gaps
The reviewed implementation provides these building blocks:

- `DefaultWallet.execute` accepts an ordered list of calls. The native implementation and extension currently limit this to 16 calls.
  
- The default wallet aborts the enclosing batch when an inner call aborts or faults. Successful earlier calls in that batch do not remain committed after rollback.
  
- The extension already decodes and displays multiple calls in one approval screen.
  
- The provider already signs and submits serialized transactions. A batched transaction can use the existing `signTransaction` and `submitTransaction` methods.
  
- The SDK's `defaultWalletAdapter` and `prepareExecution` convenience path currently accept one invocation.
  
- Provider discovery and sessions do not currently advertise batching capability.
  
- Both apps persist and recover progress as individual transaction steps. Several steps sharing one hash need explicit support.
  

Relevant source:

- SDK: `src/provider/types.ts`, `src/provider/validation.ts`, `src/wallet/invocationAdapter.ts`, and `src/wallet/providerClient.ts`.
  
- Extension: `apps/wallet-extension/src/transactions.ts`, `worker.ts`, `inpage.ts`, and `ui.tsx`.
  
- Launchpad: `apps/token-launchpad/src/launch/executor.ts`, `workflow.ts`, and `transactions/provider-wallet.ts`.
  
- Swap: `apps/swap/src/transactions/creation-executor.ts`, `creation-workflow.ts`, `provider-wallet.ts`, and the swap/liquidity executors.
  

Recheck these APIs and limits at implementation time. The apps use a published SDK version; local SDK source changes alone do not update the installed apps.
## Transaction groups
### Token creation
Proposed transaction:

1. Transfer the required native funding to the predicted token address, if needed.
  
2. Create and initialize the token through the token factory.
  

Attach the required token implementation to the transaction using the existing artifact validation. Preserve the reviewed nonce, metadata, supply, administrator, holder, and predicted address.

Before adopting this group, prove that the factory sees funding from an earlier call in the same transaction on the exact supported runtime. Current native balance code and a factory test support this direction, but an older batching demo explicitly waits for funding to commit. Do not infer deployed behavior from the test fixture alone.

If this dependency is not supported, keep funding and creation separate and record the reason. Do not present a two-transaction flow as atomic.
### Pool creation and initial liquidity
Proposed first transaction:

1. Approve the required factory HOG funding, if needed.
  
2. Create the pool contracts.
  
3. Approve token 0 for the predicted pool handler, if needed.
  
4. Approve token 1 for the predicted pool handler, if needed.
  
5. Submit the initial liquidity request.
  

Use the factory's existing `pool_addresses` prediction before preparing the batch. Verify that the resulting pool addresses match that prediction. Attach the LP-token implementation when required.

Proposed second transaction:

- Process the liquidity queue after the first transaction commits and its request ID is verified, if the request still needs processing.
  

Keep queue processing separate in the first release. It has its own admission budget, backlog behavior, and request-result checks. Honor the existing manual-processing option. A successful enqueue transaction does not mean liquidity has been minted.

Prove that factory funding approvals, new pool state, and token allowances can be used by later calls in the same transaction. Test pool-creation races and rollback. Split the group at a required confirmation boundary if the runtime or contracts require it.
### Existing-pool operations
After the creation workflows are verified, combine any required token approvals with swap, add-liquidity, or remove-liquidity request submission. Keep queue processing separate initially. Preserve exact amounts, slippage bounds, recipient, and allowance accounting.
## Provider capability negotiation
Add a non-interactive `getCapabilities` request to the provider contract and SDK. Final field names should be agreed in the SDK review.

The response must identify whether the selected account on the selected network supports atomic multi-call execution and state the maximum supported call count. It must distinguish atomic execution from merely signing multiple transactions.

Requirements:

- Do not infer support from provider name, extension ID, or the presence of an account.
  
- Validate capability responses at the SDK boundary and bind them to the current account/network session.
  
- Clear cached capabilities when that session changes.
  
- Use an additive request method rather than adding unrecognized fields to existing strictly validated session objects.
  
- Treat error `4200` (unsupported method), or an explicit unsupported capability, as the legacy single-call path.
  
- A malformed response, network error, or permission error is not an unsupported capability. Report it and permit retry; do not silently guess support.
  
- Capability discovery must not prompt for a signature or broadcast anything.
  

Older wallets must remain usable without upgrading. The Thruput extension should advertise only the limits and behavior it actually implements.
## SDK and extension behavior
Add a batch-preparation method alongside the existing single-call method. It should:

- Accept an ordered, bounded list of invocations and existing deployment attachments.
  
- Build one root `DefaultWallet.execute` invocation directly. Do not wrap a wallet batch inside another wallet execution.
  
- Snapshot caller inputs before asynchronous work and apply existing transaction-size, account, network, nonce, and expiry validation.
  
- Enforce the negotiated call limit and provide a way to decode results in call order.
  
- Keep prepare, sign, persist, and submit as separate operations.
  
- Retain the existing checks that submitted bytes match the approved transaction exactly.
  

Use the extension's existing multi-call review. Verify that it shows all calls in order, their targets, amounts or decoded arguments where supported, aggregate transaction gas, and attached deployments. One approval authorizes exactly that batch. Rejection and timeout keep the existing cancellation behavior.

Publish the SDK changes and update the extension/apps to the published version before enabling the new app path.
## App progress and recovery
Represent each submitted group explicitly: its ordered member steps, account/network scope, transaction hash, and status. Version persisted workflow data as needed.

- Choose batching before signing, based on validated capabilities and the remaining safe workflow steps.
  
- Preserve the current single-call flow for unsupported wallets.
  
- Persist the signed batch hash before broadcast, as the apps already do for individual transactions.
  
- While a batch is pending, show its member steps as part of one approval/transaction rather than implying each needs a signature.
  
- On a verified successful receipt, apply the results to all member steps and validate the expected events, addresses, amounts, and outputs.
  
- On a reverted batch, do not mark earlier member calls as committed.
  
- On an uncertain broadcast result, recover the original hash. Do not fall back to individual transactions or automatically replace the batch.
  
- A user rejection must not trigger a second set of single-call approval prompts.
  
- A definitive failed or never-submitted attempt may be retried after fresh validation and explicit user action.
  
- Existing partially completed workflows must remain recoverable. The initial implementation should finish legacy workflows with their existing step model rather than regrouping transactions that may already have been signed.
  
- Preserve account-change invalidation, network checks, durable recovery, and allowance/reservation accounting.
  

Batch atomicity covers the calls in that transaction, not later queue execution. Continue tracking the accepted request through its terminal success or failure events.
## Gas and runtime limits
A batch has one root transaction budget and a separate limit for each inner call. Do not reuse the old single-call root budget unchanged or multiply a generic allowance without checking actual requirements.

- Size each supported group from the current operation limits plus wallet/transaction overhead.
  
- Verify supported node limits, serialized transaction size, deployment attachments, and wallet return-data limits.
  
- Keep the independent crank budget aligned with the production minimum batch and maximum request cost.
  
- Check that supported test wallets can fund the resulting execution allowance.
  
- Document the CLI, node release, SDK version, and contract artifacts used for the evidence.
  
## Implementation sequence
1. Prove the proposed call groups on an isolated node using the supported runtime. Include rollback and within-transaction reads. Record any required confirmation boundaries.
  
2. Add and test capability negotiation and batch preparation in `client-ts`; publish the SDK release.
  
3. Update the extension to advertise support and verify its multi-call approval behavior.
  
4. Integrate token-creation batching and durable recovery, retaining the legacy path.
  
5. Integrate pool-creation batching and separate queue processing.
  
6. Reuse the verified mechanism for existing-pool swap and liquidity workflows.
  

Keep these as focused, reviewable changes across the two repositories. This spec does not authorize implementation; obtain approval before starting this workstream.
## Acceptance criteria
- A completed token launch takes one approval when the supported runtime permits funding and creation in one transaction.
  
- Pool creation with initial liquidity takes two approvals in the supported grouped path, with verified pool creation, request acceptance, and final liquidity ownership.
  
- An older provider returning `4200` completes the existing single-call workflow.
  
- A supported provider presents one complete review per batch and signs exactly the displayed transaction.
  
- A failure in a later call rolls back earlier calls in that batch, with no misleading committed progress.
  
- Reload, disconnect, timeout, and ambiguous submission recover the original transaction and do not duplicate funding, creation, approvals, or requests.
  
- Existing saved workflows continue to recover after the upgrade.
  
- Gas checks include busy queues; success on one initial liquidity request is insufficient evidence for crank capacity.
  
- Browser acceptance exercises both batched and legacy paths through the real extension, with chain-state assertions rather than UI-only success checks.
  
## Decisions to confirm during implementation
- Exact capability schema and SDK batch method name.
  
- Which runtime releases guarantee the within-transaction visibility needed by each group.
  
- Final root budgets for supported groups using the latest calibration.
  
- Persisted workflow migration details and batch result decoding.
  
- Whether combining queue processing into an earlier transaction is worthwhile later. It is outside the initial release.
