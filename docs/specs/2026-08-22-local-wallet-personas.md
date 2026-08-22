# Local Wallet Personas Plan
Status: Approved

Date: 2026-08-22
## Goal
Provision three disposable local users and let a developer switch among them in the browser without restarting Vite. All users share one factory, router, token set, and seeded pool. Each user has distinct balances, allowances, LP positions, transaction history, and recovery state.

The pool has no contract-level owner. Alice will be the pool-creation caller and initial liquidity provider. Her LP-token balance represents her position. Bob and Carol can see and use the same pool, but they begin with no LP position.
## Personas
Use three existing bootstrap `local_user` accounts from the runtime manifest:

| Persona | Manifest account | Initial role |
| --- | --- | --- |
| Alice | `roleOffset: 0` (`dev-1`) | Contract deployer, token administrator, pool creator, initial LP |
| Bob | `roleOffset: 1` (`dev-2`) | Funded trader |
| Carol | `roleOffset: 2` (`dev-3`) | Funded trader and prospective LP |

Roles describe the initial demonstration state. The contracts do not restrict Bob or Carol from creating pools, adding liquidity, removing their own liquidity, swapping, or processing a shared driver queue.

Local setup requires the runtime manifest to contain `dev-1`, `dev-2`, and `dev-3`. Nodes must start with at least `--dev-account-count 3`; setup must not add custom wallet deployment merely to manufacture another user.
## Keep The Model Simple
1. Use existing manifest accounts and their deployed DevWallet contracts.
  
2. Keep one shared AMM deployment.
  
3. Keep Alice as the administrator for the example ERC20 contracts.
  
4. Mint useful balances of all three example tokens to each persona.
  
5. Seed exactly one A/B pool from Alice and mint its initial LP position to Alice.
  
6. Keep account selection tab-local with `sessionStorage`.
  
7. Keep transaction state in the existing account-scoped `localStorage` namespaces.
  
8. Remount the complete routed application when the active account changes.
  
9. Never persist private keys in browser storage.
  
10. Keep the selector and all signing credentials development-only.
  
## Setup Changes
### Load Three Users
In `apps/swap/scripts/setup-local.ts`:

- Replace the singular `applicationUser` with a three-element persona list loaded through `loadLocalDevAccount({ role: "local_user", roleOffset })`.
  
- Continue loading the faucet separately with `role: "faucet"`.
  
- Fail before ledger mutation if any required persona is unavailable.
  
- Derive each browser private key from the manifest seed and that account's verified derivation index, using the same derivation currently used for Alice.
  

The setup should accept a fixed three-persona topology rather than a configurable count. A fixed topology keeps generated configuration, UI labels, and acceptance tests deterministic.
### Shared Deployment
Alice performs the current deployment and initialization work:

- Register pair, handler, driver, and ERC20 code.
  
- Deploy and initialize the three example tokens.
  
- Deploy and initialize the factory and router.
  
- Remain the administrator of the example tokens.
  

The faucet continues to provide native HOG funding for contracts. Existing bootstrap users already receive native HOG from the node. Setup should verify that each persona has enough HOG for normal transactions and the configured four-contract pool prefunding requirement; it should fail clearly if the node was started with insufficient account funding.
### Token Distribution
Mint the same useful balance of gUSD, gEUR, and gJPY to Alice, Bob, and Carol. Keep the current amount unless live testing shows it is too small.

Alice then contributes the existing initial A/B amounts. Her remaining token balances will differ from Bob's and Carol's, which makes account switching immediately visible.
### Seeded Pool
Keep one setup-created gUSD/gEUR pool:

- Alice approves the pair handler.
  
- Alice submits the initial add-liquidity request.
  
- Alice processes the request.
  
- Alice is the LP recipient.
  
- Setup verifies the expected reserves and positive Alice LP balance.
  
- Setup verifies that Bob and Carol have zero LP balance.
  

Use “initial liquidity provider” and “LP position,” not “pool owner.” The factory, pair, handler, and driver do not record an owner or grant creator privileges.
### Generated Environment
Keep shared public configuration as individual environment values:

- RPC URL and network ID
  
- native HOG, factory, and router addresses
  
- pool funding amount
  
- wallet entrypoint
  
- existing fixed-pool values required by current local integration tests
  

Generate one compact, unprefixed JSON value containing the disposable persona records:

```json
[
  {
    "id": "alice",
    "label": "Alice",
    "description": "Initial liquidity provider",
    "accountAddress": "0x...",
    "privateKey": "0x..."
  },
  {
    "id": "bob",
    "label": "Bob",
    "description": "Trader",
    "accountAddress": "0x...",
    "privateKey": "0x..."
  },
  {
    "id": "carol",
    "label": "Carol",
    "description": "Liquidity provider",
    "accountAddress": "0x...",
    "privateKey": "0x..."
  }
]
```

Retain `VITE_GROUNDHOG_WALLET_ADDRESS` and the CLI default as Alice for compatibility with current integration commands and shell tooling. The browser selector overrides only the active runtime account.

Write `.env.local` atomically and with mode `0600`, as today. Print all persona labels and addresses when setup completes, but never print their private keys.
## Development Credential Boundary
Update `apps/swap/vite.config.ts` to inject the persona JSON only when all of these conditions hold:

- Vite command is `serve`.
  
- The server is not running in preview mode.
  
- The configured RPC URL is loopback.
  

Build and preview must receive `undefined`. Persona private keys must not use the `VITE_` prefix and must not enter generic `import.meta.env` exposure.

This also closes the existing gap where the singular development key can be injected during `vite serve` even when the configured RPC target is non-loopback.
## Browser Configuration
Add a small persona parser, separate from AMM configuration parsing. It must:

- Validate a nonempty array.
  
- Validate known, unique persona IDs.
  
- Validate unique 32-byte account addresses and private keys.
  
- Keep each address and key in one immutable record so they cannot be mixed.
  
- Select Alice by default.
  
- Read only the selected persona ID from `sessionStorage`.
  
- Ignore a stale selected ID after setup or node replacement and return to Alice.
  

Suggested preference key:

```text
groundhog-swap:active-persona:v1:<networkId>:<factoryAddress>
```

Use `sessionStorage`, not `localStorage`, so separate tabs can intentionally act as different users. Never store a private key in either storage system.
## Runtime Architecture
### Separate Shared Config From Active Identity
Keep network, RPC, factory, router, native HOG, and funding values static. Derive the existing `GlobalConfig` from the active persona:

```ts
const config: GlobalConfig = {
  ...sharedConfig,
  accountAddress: activePersona.accountAddress,
};
```

Do not add private-key material to `GlobalConfig` or `AppConfig`.
### Pass Signing Material Explicitly
Change `createBrowserLocalWriteBoundary` so callers provide the active persona's private key. Remove its hidden dependency on the singular `import.meta.env.GROUNDHOG_DEV_PRIVATE_KEY`.

Pass the active wallet record explicitly through `AmmRoutes` to the transaction-capable pages:

- swap
  
- pool creation
  
- liquidity management
  

Pool detail and directory pages need only the derived account address because they perform account-bound reads but do not sign.

Tests may continue injecting explicit write boundaries.
### Remount On Switch
Keep `BrowserRouter` mounted so the URL remains unchanged. Key the entire routed runtime by network and account address:

```tsx
<AmmRoutes
  key={`${networkIdHex}:${accountAddressHex}`}
  config={activeConfig}
  wallet={activeWallet}
/>
```

This deliberately resets:

- route-derived pool configuration
  
- snapshots and stale snapshot data
  
- readers, writers, and event observers
  
- form input and reviewed quotes
  
- pool-creation and liquidity component state
  
- swap reducer state, timers, and listeners
  

Do not clear durable transaction records. Existing keys already include network and account, so switching back restores that account's requests, liquidity operations, creation workflows, crank attempts, reservations, and recovery controls.
### Serialize The Switch
Use the current account's existing network/account Web Lock when switching. If a transaction flow currently holds the lock, the selector waits and shows a switching state. Once the lock is acquired, update the selected persona and remount the runtime.

This avoids building a new global busy-state system and prevents switching during the critical pre-sign, signed-hash persistence, and submission window. Queued or otherwise durable unresolved work does not block switching.
## Wallet Selector UI
Add one small development-wallet control available on every route.

The control should show:

- Active persona label.
  
- Shortened account address.
  
- Development-only indicator.
  
- Menu options for Alice, Bob, and Carol with their short addresses and initial role descriptions.
  

Place it in both existing headers:

- `AmmPage` for pool list, creation, detail, and liquidity.
  
- `SwapPage`'s existing account header.
  

Use one context for public selector state and the switch action so both headers render the same control. The context should not expose every private key. The top-level runtime retains the complete persona records and passes only the active signing record to transaction-capable routes.

Switching should preserve the current URL. After a switch, show loading state until the new account's coherent snapshot arrives; never leave the previous account's balances or allowances visible under the new label.
## Account And Queue Semantics
- Pools and driver queues are shared across personas.
  
- Token balances, allowances, LP balances, and durable operation histories are account-specific.
  
- One persona's crank may process another persona's request in the same driver queue. Existing event observers must reconcile that when the other persona becomes active again.
  
- Web Locks remain account-specific, so different personas can transact concurrently in separate tabs.
  
- Browser operational records remain origin-specific; `localhost` and `127.0.0.1` still represent separate local state domains.
  
## Specifications And Documentation
Update the AMM specification and TypeScript setup specification to:

- Remove account switching from the AMM non-goals for local development.
  
- Define the three disposable personas and tab-local selection.
  
- Replace the empty-registry setup topology with the newly agreed single seeded pool.
  
- State that Alice is the initial liquidity provider, not the pool owner.
  
- Require serve-only, loopback-only exposure of all persona credentials.
  
- Describe account-scoped persistence and full runtime remounting on selection.
  

Update the swap README with:

- Required node account count of at least three local users.
  
- Setup and Vite restart instructions.
  
- Persona balances and initial LP state.
  
- Wallet-switching behavior across tabs.
  
- A warning that every persona credential is disposable and visible to browser code during local development.
  
## Minimal Test Set
Keep tests focused on boundaries that could cause the wrong account to sign or display:

1. Persona configuration rejects malformed, duplicate, or mismatched records and defaults stale selection to Alice.
  
2. Vite injects persona credentials only for loopback development serve and excludes them from build and preview.
  
3. The write boundary wraps and signs with the explicitly selected account/key pair.
  
4. Switching preserves the URL, remounts account-bound state, and replaces the displayed balance only after the new snapshot loads.
  
5. Account A's local transaction records remain untouched and are restored after switching away and back.
  
6. A switch waits for the current account Web Lock instead of interrupting an active write.
  
7. A live setup check confirms distinct addresses and token balances for all personas, Alice's positive LP balance, and zero initial LP for Bob and Carol.
  

Do not duplicate the extensive existing request, reservation, and lock suites. Their keys already include account addresses.
## Manual Acceptance
On a fresh node with at least three local users:

1. Run setup and start Vite.
  
2. Confirm the shared A/B pool appears for Alice, Bob, and Carol.
  
3. Confirm only Alice begins with an LP position.
  
4. Swap as Bob and confirm only Bob's balances and history change.
  
5. Switch to Carol, add liquidity, and confirm Carol receives LP tokens.
  
6. Remove part of Carol's LP position and confirm she receives both reserve assets.
  
7. Switch back to Alice and confirm Alice's LP position and history remain intact.
  
8. Open separate tabs as Alice and Bob and confirm selection is tab-local.
  
9. Leave a queued request for one persona, switch away, process the shared queue from another persona, then switch back and confirm event recovery.
  
10. Run a production build and confirm no private key or persona manifest appears in emitted assets.
  
## Implementation Order
1. Update specifications and terminology.
  
2. Provision and validate Alice, Bob, and Carol in setup.
  
3. Generate the serve-only persona manifest.
  
4. Parse personas and hold active selection above the router.
  
5. Pass the selected private key explicitly to writers.
  
6. Key the complete route runtime by account.
  
7. Add the shared selector to both headers.
  
8. Add focused boundary tests.
  
9. Run the fresh-ledger three-persona acceptance sequence.
  
## Explicit Non-Goals
- Production wallet connection or wallet-standard integration.
  
- Importing arbitrary private keys.
  
- Creating custom wallet contracts when manifest users are available.
  
- Editing persona labels or balances in the UI.
  
- Persisting private keys or selected signing material.
  
- Claiming that Alice owns the pool.
  
- Giving personas protocol permissions or access controls.
  
- Synchronizing the selected persona across tabs.
