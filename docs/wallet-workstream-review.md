# Wallet workstream review

## Scope and conclusion

Reviewed the client-ts provider API, Chrome extension, Swap, Token Launchpad,
infrastructure provisioning, and demo seeding. Independent reviews were followed
by fixes, targeted regressions, and isolated browser/ledger acceptance.

No remaining actionable findings were identified in the reviewed scope after
the fixes below. This is an engineering review of an experimental wallet, not an
external security audit or a guarantee that the implementation is defect-free.

## Provider API

The five-method contract remains intentionally small: `connect`, `getSession`,
`disconnect`, `signTransaction`, and `submitTransaction`.

- Ethereum-inspired promise-based requests and structured numeric errors.
- Multiple-provider discovery without competing for a singleton global.
- Wallet Standard-inspired explicit accounts, full session snapshots, and
  subscriptions that return cleanup functions.
- Groundhog-native transaction formats, with no Ethereum or Solana wire
  compatibility claim.
- Separate signing and submission so apps persist the canonical hash before
  broadcast. Returned bytes and network-bound signatures are verified by the SDK.

The specification now requires connection/disconnection changes to reach page
listeners before the corresponding request resolves. The extension bridge
enforces this ordering. Parser documentation also distinguishes data snapshots
from the original live provider object whose identity and method receivers are
preserved. No capability framework or duplicate public API was added.

## Corrections

### Extension

- Canceled connection approvals cannot retain account access after cleanup
  storage failures or worker restart.
- Preflight requests enter the bounded pending-request map before asynchronous
  checks, allowing cancellation before a popup exists.
- Portfolio refresh uses one account/network-scoped loading path. Late balances
  and errors cannot overwrite another account's screen.
- Pending and completed transfer reviews are generation-scoped. Switching away
  and back cannot revive a stale prepared transaction.
- Regression checks cover the approval timeout and windows that finish opening
  after cancellation.

Connection grants are now worker-memory-only. Lock/unlock within the same worker
retains grants, but worker termination requires fresh site approval. This is an
explicit prototype tradeoff; encrypted vault data and transaction recovery
records remain persistent. Durable remembered permissions can be added later
with a defined approval/revocation commit boundary.

### Apps

- Launchpad retains the previous 1,000-block transaction expiry allowance.
- Checking a funding transaction only observes it. Creating the token afterward
  requires an explicit action; an initial Launch token action may still continue
  its reviewed workflow automatically.
- Pool-detail read failures have a Try again action.
- Pool directories refresh on focus/visibility and every 15 seconds while
  visible. Background failures preserve results; later pages retain their
  offset and pinned registry snapshot. No header Refresh button was restored.
- Public configuration changes remount wallet boundaries disconnected. Equivalent
  configuration objects preserve the current connection and draft.
- Launchpad validates copied production artifacts as well as source artifacts.
- Removed Swap's duplicate submission-hash check, already enforced by the SDK.

### Seeding

The separate [demo seeding flow](demo-seeding.md) creates tokens through the
Launchpad factory and resolves them through its canonical registry API before
creating a pool. It never inserts index rows directly. Review verified durable
state publication, local-only RPC without redirects, original-transaction
recovery, continued processing after partial cranks, and the deployed
factory/router relationship before mutation.

## Verification

| Area | Result |
| --- | --- |
| Client SDK | 526 tests passed; 2 existing conditional golden-vector skips |
| Extension | 69 tests passed |
| Swap | 916 tests passed |
| Token Launchpad | 531 tests passed |
| Typechecks | Passed across all four projects |
| SDK formatting, docs, build, package boundaries, ESM/CJS smoke | Passed |
| Controlled app production builds and artifact guards | Passed |
| Isolated Chromium connection and race checks | Passed |
| Full local/production wallet journey | 21 checks passed, zero blockers |
| Seed integration: explicit recipient and tool-account ownership | Both passed |

Final browser evidence is under
`/tmp/opencode/wallet-acceptance-449BPp/evidence/`. The journey exercised real
extension approvals, two token launches, pool creation, swaps, liquidity,
rejection, account changes, ERC20 transfer, and both production servers. User
environment files and the running local ledger were preserved.

Devnet was not retested in this review. Full transaction simulation, remote
production deployment, and independent external auditing remain outside this
prototype scope. See [wallet acceptance](wallet-acceptance.md) for commands and
coverage limits.
