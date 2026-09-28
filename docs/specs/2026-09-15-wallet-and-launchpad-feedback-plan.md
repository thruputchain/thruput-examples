# Wallet and token launchpad feedback plan

Status: Reviewed implementation plan. The findings below describe the code before the fixes.

Implemented approval-timeout recovery, progress preservation through reconnects, clearer wallet setup, equal 20px toolbar gaps, a Devnet default for new wallets, and full token symbols in the preview. Browser checks covered timeouts at both launch steps and successful pool creation. Persistent site connections remain a separate follow-up.

## Summary

the reporter's pause could have triggered a wallet approval timeout before any transaction was sent. Block-height expiry is also possible, but the report does not establish it. The reconnect problem needs a browser reproduction before we assign a root cause.

Start with the 115-second wallet approval timeout and follow its retry and reconnect behavior. Defer block-expiry investigation and storage changes unless this reproduction points to them. The proposed work is to make approval recovery clear, preserve launch progress through reconnects, and make wallet setup clear.

## 1. What the code tells us

### Three separate deadlines

| Deadline                                | Current behavior                                                                                                  | Source                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Wallet approval: 115 seconds            | Rejects the request with `Approval timed out` and closes the approval window.                                     | `apps/wallet-extension/src/worker.ts:342–415`                   |
| Page request: 120 seconds               | Rejects with `Wallet request timed out` and sends cancellation to the extension.                                  | `apps/wallet-extension/src/inpage.ts:57–70`                     |
| Wallet session: 10 minutes after unlock | Locks the wallet and cancels pending approvals. A worker restart also loses the unlocked session and site grants. | `apps/wallet-extension/src/worker.ts:234–259`, `ui.tsx:478–481` |

The launchpad separately prepares each transaction with a **1,000-block lifetime** before requesting a signature (`apps/token-launchpad/src/transactions/provider-wallet.ts:40–46`). We cannot convert that lifetime into the reporter's waiting time without the relevant chain heights or block rate.

### Best current explanation

1. A launch can require two approvals: funding the predicted token address, then creating the token.

2. A request timeout before the signature reaches the app becomes a `preSubmissionFailure`. The executor returns the step to `idle` and stores the error.

3. The UI presents all stored errors under **Launch paused**. For an idle funding step, its action becomes **Fund token address**, rather than an explicit retry message.

4. If the reporter saw the exact **Edit token details** button, the current code says both steps were idle with no saved transaction hashes. That favors a failure during the first approval, before confirmed funding. His wording was approximate, so this is a clue rather than proof.

5. A normal approval timeout uses error code `4001`. It does not itself revoke the site connection or invalidate the SDK signing client. The later disconnection therefore needs another explanation: wallet locking, worker restart, network reconnect, another provider error, or different deployed code.

### Confirmed recovery gaps

- **Connection state can become stale.** The installed SDK invalidates its signing client on `4100`, `4900`, or `4901` errors. The launchpad converts these into plain error text without updating its connection state. Without a provider change event, it can still show a connected account whose signing client is unusable.

- **Reconnect hides context.** The create route becomes a generic connection prompt when disconnected. Reconnect mounts a new launch page and loads the saved workflow, including its previous error. Seeing the same error again does not prove a second transaction attempt failed.

- **Uncertain submission can have no clear exit.** After a submission error, the app observes the hash. An explicit invalid result permits retry. Repeated unknown results remain uncertain. Stored steps contain a status and hash, but no expiry height or submission stage to support further recovery.

- **Edit clears the form.** The current edit action discards the workflow and resets token details to defaults.

- **Reconnect has two meanings.** The extension toolbar's Reconnect action resets the network connection and clears site grants. Users must then reconnect from the app. It is not the same action as reconnecting the launchpad wallet.

Relevant files: `launch/executor.ts`, `launch/presentation.ts`, `launch/use-launch.ts`, `launch/workflow.ts`, `transactions/provider-wallet.ts`, `transactions/transaction-observation.ts`, `wallet/wallet-provider.tsx`, and `routes.tsx` under `apps/token-launchpad/src/`; `apps/wallet-extension/src/ui.tsx:585–624` and `worker.ts:650–672`.

### What remains unknown

- The full message beneath **Launch paused**, on both occasions.

- Whether the reporter approved funding before the pause, and whether either step showed a transaction hash.

- Roughly how long he waited, whether the wallet locked, and which Reconnect control he used.

- The deployed launchpad revision and extension build used for the report.

A screenshot of the full paused card, transaction hashes, or the saved launch workflow would help distinguish these paths. No password, recovery phrase, or private key is needed.

## 2. Reproduce the launch failure first

Use a test wallet and record the launch step, provider error code, connection changes, and any transaction hash. Start with approval timeout alone; expand only when the result requires it.

1. Leave the first approval open past 115 seconds. Retry from the launchpad.

2. Complete funding, then leave the creation approval open past 115 seconds. Retry creation.

3. Follow the reporter's full sequence: pause, edit, launch, reconnect, and continue. Include reload during recovery.

4. If timeout alone does not explain the disconnection, test the extension toolbar's Reconnect action, then wallet lock and worker restart. Check the app's connection state before and after reconnect.

Capture the deployed versions before comparing browser results with this source tree. Select the root-cause fix from the reproduction evidence.

## 3. Proposed launch recovery UX

Each state should show what happened and one clear next action.

| State                                  | Message                                                                        | Primary action           |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------------ |
| Approval timed out before submission   | “Wallet approval timed out. Try again to open a new request.”                  | Retry approval           |
| User rejected approval                 | “You canceled the wallet request. Your token details are saved.”               | Try again                |
| Connection lost                        | “Reconnect your wallet to continue this launch. Your progress is saved.”       | Reconnect wallet         |
| Submission outcome unknown             | “We could not confirm this transaction. Check its status before trying again.” | Check transaction status |
| Funding committed, creation incomplete | “Funding is complete. Continue to create your token.”                          | Continue creation        |

Implementation approach:

- Preserve the failure information needed to distinguish approval timeout, rejection, and connection loss. Keep useful error details available for diagnosis and retain the existing handling for unknown submission outcomes.

- On connection errors, recheck the provider session and replace or clear the unusable signing client. Reconnect must bind a fresh client to the correct account and network.

- Preserve the launch summary during disconnection. After reconnect, show the current recovery action instead of presenting an old error as a new failure.

- Retain public-RPC receipt checks for any saved transaction hash. Exposing them while disconnected is follow-up work if the timeout reproduction shows it is needed.

- Reconcile saved state under the existing workflow lock after reconnect. Prevent late work from an old page from overwriting a newer attempt.

- Retry only the incomplete step. Prepare fresh transaction bytes and require a fresh signature. Retain the application nonce, predicted address, and any committed funding.

- Keep expiry tracking and workflow storage migrations out of the initial fix. Continue to preserve any transaction hash and check its outcome before allowing a replacement.

- Make **Edit token details** preserve the entered values. Keep a separate **Start over** action only where the existing transaction evidence permits discarding the workflow. Explain why a funded launch must continue at its existing address.

- Explain that a launch may need two wallet approvals. While waiting, show the current step and tell the user how to retry if the request times out.

## 4. Wallet setup and unlock UX

Recommendation: keep the compact single-screen form and make its selected mode explicit.

- Use accessible **New wallet / Restore wallet** tabs with a strong selected state and keyboard support.

- Give each form a matching heading and explanation.

- Keep one primary submit action below the fields.

- Use `new-password` autocomplete for setup and `current-password` for unlock. Show the existing 12-character requirement next to the password field.

- Move derivation details into an expandable technical section so the setup instructions come first.

Suggested copy:

**Create a wallet**

> Choose a password with at least 12 characters and enter it twice. This password encrypts your wallet on this device. Use it to unlock your wallet later.

Primary action: **Create wallet**

**Restore a wallet**

> Enter your recovery phrase, then choose a password for this device. You do not need the password from your previous device.

Primary action: **Restore wallet**

Keep **Unlock wallet** for an existing local wallet and **Connect wallet** for sharing an account with a site. These are separate steps. Continue to explain in a connection popup that unlocking does not approve the connection.

## 5. Wallet toolbar

- Make the network select fill the remaining row width.

- Use a fixed **20px gap** between the select and the action-button group.

- Keep Reconnect and Lock at their natural widths, with a compact gap within the group.

- Replace distributed `space-between` spacing with a flexible select and a non-shrinking button group. Verify at the extension's 400px width and minimum supported width.

- Consider **Reconnect network** as the button label, subject to width checks, with helper text explaining that apps must reconnect afterward. The existing label is ambiguous in this incident.

## 6. Delivery order and checks

1. Reproduce and identify the launch failure using the scenarios above.

2. Fix approval retry and any connection recovery issue found in the reproduction. Add regression tests for that sequence.

3. Update launch messages, actions, and progress preservation.

4. Update wallet setup copy, mode selection, and toolbar spacing.

5. Verify the full flow in a browser, including creating a token and reaching Swap's pool form.

Required recovery checks:

- Timeout at either approval permits a fresh request without losing details.

- Reconnect restores the correct launch and a usable signing client.

- Confirmed funding is never repeated during creation recovery.

- A pending or uncertain transaction is checked before a replacement is allowed.

- Approval timeout returns to a usable retry state; any saved transaction hash and evidence remain intact.

- Reload, account changes, and late responses do not mix or overwrite workflows.

- New-wallet and restore modes are visually and programmatically distinct.

Investigation checks already run: 45 tests passed across the launchpad executor, launch flow, provider write boundary, and wallet flow; 67 wallet worker tests passed. These establish the current baseline, not a reproduction of the reporter's complete incident.

## Review questions

1. Can we get the exact paused error text or a full screenshot, plus an approximate wait time?

2. Are the proposed tabs, password explanation, and single primary action clear enough for wallet setup?

3. Should the toolbar label become **Reconnect network** to distinguish it from the app's reconnect action?

---

comments:
c2:
body: "Agreed. The plan now starts with the 115-second approval timeout at each launch step, then follows the reporter's edit and reconnect sequence. Block-expiry investigation and storage migrations are deferred unless that reproduction provides evidence for them. Lock and worker-restart checks are conditional follow-ups."
by: AI
at: "2026-09-15T21:51:12Z"
re: c1
