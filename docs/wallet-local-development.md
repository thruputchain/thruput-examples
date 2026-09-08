# Wallet Local Development

Run Launchpad and Swap against one disposable local node using the Groundhog
Wallet Chrome extension. Use test funds and a test recovery phrase only. The
extension is experimental and has not received an independent security audit.

## Install

Use Node.js 22.13 or newer, npm, Chrome/Chromium, the repo's pinned Rust toolchain,
and access to the Groundhog Rust and GitHub Packages registries. Keep registry
credentials in user-level configuration, never in the repo.

The sibling `../groundhog-client-ts` must contain the wallet-provider work and
built `/provider` and `/wallet` exports (currently SDK 0.7.0). All three apps
already declare `file:../../../groundhog-client-ts`; do not add another dependency
or publish a package. From the **repository root**, run in order:

```sh
npm --prefix ../groundhog-client-ts install
npm --prefix ../groundhog-client-ts run build
npm --prefix apps/token-launchpad install
npm --prefix apps/swap install
npm --prefix apps/wallet-extension install
```

Rebuild the SDK after changing its source, then rebuild the extension and refresh
the apps. These are local dependencies; no publish or push is required.

## Prepare Infrastructure

Start a compatible disposable node separately at `http://127.0.0.1:9545`, the
extension's fixed Localnet endpoint. Localnet identity must be 32 zero bytes.
Use a CLI/devnode pair that supports the SDK's RPC wire format (4 or newer) and
test-HOG airdrops. A CLI version minimum alone does not establish compatibility;
see [wallet acceptance](wallet-acceptance.md) for the tested pair and protocol
caveats. Do not change or stop an existing user's node to force compatibility.

Obtain that running node's **complete runtime manifest**. Launchpad requires
`networkHash` and `bootstrap.storageCostModel`, including the pinned profile hash
and every cost field: `baseDataItemCost`, `bytestringCostPerByte`,
`baseContractDeploymentCost`, `contractDeploymentCostPerByte`, `authPerKeyCost`,
`rcqCostPerEntry`, `replayCacheCostPerEntry`, and `balanceCost`. A network-only
manifest or guessed cost values will fail validation. Bootstrap user accounts
are not required; setup funds a temporary tool-only deployer via airdrop.

From the repository root, provision **sequentially**, never concurrently:

```sh
export GROUNDHOG_CLI=/absolute/path/to/compatible/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/absolute/path/to/runtime-manifest.json
export GROUNDHOG_RPC_URL=http://127.0.0.1:9545
npm --prefix apps/swap run setup:local
npm --prefix apps/token-launchpad run setup:local
```

Setup builds contracts, deploys and initializes infrastructure, and replaces each
app's `.env.local` with public configuration. Swap creates its factory/router and
registers handler/driver code; launchpad creates its zero-fee token factory.
**No user wallets, tokens, pools, or seeded liquidity are created.** Temporary
deployer keys are not exported to the browser.

Each setup publishes immutable `public/contract-artifacts/<hash>.json` in its app,
with a lowercase `0x`-prefixed filename and exactly `contractType`, `data`, and
`hash` fields. Launchpad's hash is `VITE_STANDARD_TOKEN_HASH`; Swap's new required
field is `VITE_POOL_TOKEN_HASH`. First token/pair creation attaches those verified
code bytes. Production builds copy and validate the artifacts; startup validates
them again. Builds do not generate missing artifacts.

**Rerun old setups** that contain personas, omit `VITE_POOL_TOKEN_HASH`, or use
mutable artifact filenames. Back up any configuration you need first. Setup is
not idempotent and writes to the ledger; after a partial failure, use a fresh
disposable ledger and reprovision both apps. Do not overwrite a valued ledger.
Restart Vite after configuration changes. Launchpad's separate deployment and
initialization transactions are suitable only for an isolated disposable node,
not public deployment tooling.

## Load And Run

Build the extension from the repository root:

```sh
npm --prefix apps/wallet-extension run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select `apps/wallet-extension/dist`. Pin Groundhog Wallet. After rebuilding,
reload the extension and refresh both app tabs.

For the simplest journey, keep registries and discovery disabled. Add these
optional settings to the generated app environments without replacing their
infrastructure values:

| File | Settings |
| --- | --- |
| `apps/token-launchpad/.env.local` | `VITE_TOKEN_REGISTRY_ENABLED=false`, `VITE_SWAP_APP_URL=http://127.0.0.1:5174` |
| `apps/swap/.env.local` | `VITE_POOL_REGISTRY_ENABLED=false`, `VITE_TOKEN_DISCOVERY_ENABLED=false` |
| Either app | Optional `VITE_EXPLORER_URL` for an explorer on the same network; blank disables links |

CTA/explorer settings accept root HTTPS origins or exact loopback HTTP origins,
without credentials, paths, queries, or fragments. The CTA is optional; manual
token addresses work without discovery. A separate registry on port 3001 is only
needed for indexed suggestions; see [cross-app operations](cross-app-operations.md).

Start these commands in **two separate terminals**, both at the repository root:

```sh
npm --prefix apps/token-launchpad run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

```sh
npm --prefix apps/swap run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Use `127.0.0.1` consistently, not interchangeable `localhost` URLs. Origins have
separate wallet permissions, workflow storage, and locks. Strict ports prevent a
busy port from silently moving an app to a different origin.

## Use The Wallet

1. Create a wallet or restore a test recovery phrase in the extension; private-key
   import is also available. Use a password of at least 12 characters and record
   the backup securely. Imported keys are not recoverable from the mnemonic.
2. Select **Localnet** and **Request test HOG**. Confirm the funded balance before
   signing app transactions.
3. Open `http://127.0.0.1:5173/create`, connect the wallet, and approve the origin
   and account. Launch two distinct tokens, for example six decimals and one
   million units each. Review every approval and wait for complete verification
   of each launch. Keep both actual token addresses.
4. Open **Create AMM Pool** or `http://127.0.0.1:5174/pools/new`. Connect the same
   account separately in Swap. Enter both token addresses and initial amounts,
   for example ten units each; review and approve each requested transaction.
5. Queue processing is automatic by default, but still needs extension approval.
   Enable manual mode if you want to separate enqueueing from processing, then
   explicitly process the liquidity queue or crank the queue. No background CLI
   crank is required. A queued receipt alone is not success: verify pool reserves
   and a positive LP balance after processing.
6. Try swapping and adding/removing liquidity. Approve any required crank and
   check final balances. Reconnect the same account after reload to recover its
   completed position. Never clear an uncertain transaction or sign a replacement
   merely because confirmation timed out; observe the original hash.

## Token Storage Reserve

An ERC20 contract may need additional native HOG to create a balance for a new
holder, even when the sender owns enough tokens. The wallet surfaces unconfirmed
transfer diagnostics such as `recentFailure` / `boundsExceeded`; those are not
proof of recipient credit.

If the token's storage reserve needs funding, explicitly **Send HOG to the token
contract address** from a funded account. The acceptance journey used `0.01 HOG`
before a new-holder transfer; that is a tested example, not a universal fee or
reserve estimate. This is advisory and a separate reviewed transfer, never a
hidden top-up or automatic retry. If a transfer is already uncertain, keep its
hash and use **Check status** rather than submitting another one.

## Devnet And Verification

Selecting Devnet in the extension does **not** redeploy apps or rewrite their
generated local configuration. Both apps' RPC, network identity, factories,
router, and code artifacts must match infrastructure deployed on devnet before
they can sign there. These local setup scripts accept loopback RPC only and are
not devnet deployment tooling. Network selection clears grants; reconnect after
switching. An unavailable devnet or failed identity probe is a blocker, not a
reason to bypass network checks.

Production app proxies also remain read-only. Connected production UI writes
go through the extension's own RPC; registry mode does not disable creation.
See [cross-app operations](cross-app-operations.md) for strict production artifacts
and matching build/runtime configuration.

Use [wallet acceptance](wallet-acceptance.md) for the isolated real-extension
runner, current evidence, and explicit coverage limits. It replaces retired
seeded-persona harnesses. Its devnet check is a limited identity/airdrop smoke,
not a devnet app-deployment test. This guide makes no mainnet, full-simulation,
or security-certification claim.
