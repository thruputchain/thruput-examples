# Thruput Wallet

An experimental Chrome Manifest V3 wallet for Groundhog localnet and devnet. Use test funds only. This MVP has not received an independent security audit.

## Build and Load

Requires Node 22.12+ and GitHub Packages read access. This extension installs
`@groundhogchain/client@0.8.0`, which includes the `/provider` and `/wallet` exports.
Follow the [registry authentication instructions](../../README.md#install-swap-and-launchpad-dependencies)
before installing dependencies.

This application builds and tests independently of Swap and Token Launchpad. Both apps support its wallet provider.

From `apps/wallet-extension`:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit
```

The local `.npmrc` selects GitHub Packages for `@groundhogchain/*`. Supply registry
authentication through your user environment; do not commit credentials.

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this application's `dist` directory. Pin **Thruput Wallet** in the Chrome toolbar. After rebuilding, reload the extension and refresh dapp tabs. Stable entrypoints are `dist/manifest.json`, `worker.js`, `content.js`, `inpage.js`, and `index.html`.

The UI uses the Thruput app theme and locally bundled IBM Plex Sans and Mono. Chrome icons are checked-in PNGs rendered from `public/favicon.svg` (the shared app lightning mark). To regenerate them, install librsvg (`rsvg-convert`) and run `npm run icons`.

Create a wallet or restore a BIP39 recovery phrase. Use a password of at least 12 characters. In Settings, reveal and securely record the recovery backup after re-entering the password. Imported private keys are listed separately and cannot be recovered from the mnemonic. Do not use a valuable production mnemonic. Site connections last only for the current background-worker session: lock/unlock in that session retains them, but a worker restart requires fresh connection approval.

## Package and publish

Run `npm run package` from this directory to build the extension and create `artifacts/thruput-wallet.zip` and `artifacts/SHA256SUMS`. The ZIP contains a `thruput-wallet/` folder ready for Chrome's **Load unpacked**. Both `dist/` and `artifacts/` are ignored by Git.

The [Publish wallet download workflow](../../.github/workflows/publish-wallet.yml) builds, checks, and publishes from `main` when wallet files change, or through a manual run on `main`. No download server or hosting service is needed.

One-time infrastructure setup:

- Add repository secret `AWS_WALLET_ARTIFACT_ROLE_ARN`. The role must trust GitHub OIDC for `repo:groundhogchain/groundhog-examples:ref:refs/heads/main` with audience `sts.amazonaws.com`.
- Allow that role to write only `wallet/*` in bucket `groundhog-public-release-artifacts-017820684264` (region `us-west-2`). The bucket must allow anonymous reads of that prefix, as it does for public CLI downloads. No object ACLs or AWS access keys are used.
- Grant this repository's Actions token read access to the private SDK packages, or provide a read-packages token as repository secret `NPM_TOKEN`.

The workflow stores the ZIP and checksum together under `wallet/<zip-sha256>/`. It verifies both public downloads before replacing the single [latest release pointer](https://groundhog-public-release-artifacts-017820684264.s3.us-west-2.amazonaws.com/wallet/latest.json).

Read `latest.json` once to get a matching `url`, `checksumUrl`, and `sha256`. Both URLs use the same immutable content path, so a later publish cannot mix versions. Participant guides should link to that release's ZIP and checksum directly. Publication no longer writes a mutable `wallet/latest/` file pair.

Downloads become available after the first successful publish. The publication gate includes the node-free `npm run test:browser -- --connect-only` check, which loads the built extension and exercises connection and approval in an isolated browser profile.

## Networks and Tokens

New wallets default to Devnet, pinned to its published network identity. Existing
wallets keep their saved network selection. Only two RPC endpoints are supported:

| Network  | Endpoint                     | Identity                                      |
| -------- | ---------------------------- | --------------------------------------------- |
| Localnet | `http://127.0.0.1:9545`      | Pinned to 32 zero bytes                       |
| Devnet   | `https://rpc.thruput.network` | Pinned on first use; refreshed when explicitly selected |

The worker owns all RPC traffic; no app proxy is needed. Chrome host match patterns cannot restrict ports, so extension CSP separately restricts connections to these exact endpoint ports. Network selection requires a reachable endpoint. Every signing and submission flow checks its live network identity. Selecting a network clears site grants and cancels approvals; reconnect from the dapp afterward. Reselect a network after a deliberate devnet reset.

Devnet is an experimental chain with an HTTPS endpoint. New wallets use the published network hash; explicitly selecting Devnet reads and pins its current identity. An unavailable or incompatible gateway can prevent connection or airdrop requests; the wallet reports the failure rather than bypassing identity checks.

HOG is the native ERC20-compatible token at `0x0000000000000000000000000000000000000000000000000000000000000001`, with seven decimals. Add other token contracts manually under Assets. Symbols and decimals come from untrusted contract metadata. Token balances use generated ERC20 view decoding. Amounts use integer arithmetic, never floating-point conversion.

**Request test HOG** uses the SDK airdrop action. Its random client nonce is persisted before the RPC call. After timeout, worker restart, or ambiguous failure, retrying uses that same nonce. A validated terminal response retires the nonce before reporting either success or execution failure, so another explicit request starts a fresh attempt. A committed result is successful only when execution reports `ok`.

**Send** prepares an ERC20 transfer through `defaultWalletAdapter`, shows the exact transaction, and asks for **Sign and send**. A send failure can still mean broadcast: retain the displayed hash and inspect it through an RPC client or explorer. Do not create another transaction just because confirmation timed out. Gas limits are explicit fixed MVP limits, not estimated fees.

Outgoing transfers have a small durable recovery record (hash, account, endpoint network, network identity, time, and outcome) saved before broadcast. These records remain visible after popup closure, lock/unlock, and worker restart. **Check status** only observes the existing hash; it never signs or submits. An unresolved transfer blocks further wallet sends from that account on that network until a terminal receipt or explicit risk acknowledgment. New sends require fewer than 64 recovery records. Existing valid records are retained even above that limit; none are silently evicted. Acknowledge reviewed records to free capacity.

A broadcast acknowledgment or `recentFailure` is not execution success. Unconfirmed transfers display a warning and retain the receipt-wait diagnostic, including `boundsExceeded`, across reopening. ERC20 contracts may need a HOG storage reserve to create balances for new holders. If that reserve needs funding, manually use **Send HOG** to the token contract address from a funded account; the wallet never tops up or resubmits automatically. Keep observing the original transfer with **Check status**.

## Manual storage recovery

If stored network settings are damaged, the Network control shows **Select network**. Unlock and select the intended network, including the one you used before. This checks its RPC identity and saves a new pin. The other endpoint does not need to be available.

If transfer recovery data cannot be identified safely, the wallet retains a `recoveryBlocked` flag and shows a notice. Wallet sends remain blocked across restarts. Valid recovery hashes remain available for **Check status**. A record with a valid identity but a damaged outcome is treated as unknown. The recovery phrase restores derived keys, not transfer history or imported keys; restoring the phrase alone does not resolve the duplicate-transfer risk.

Use the following repair only after one of these conditions is met:

- You have accounted for every attempted transfer, including entries missing from damaged storage, and verified its terminal outcome on the original network. Checking only the hashes still visible in the wallet is insufficient if others may be missing.
- The affected disposable test ledger has been deliberately reset or retired, and you have confirmed that old pending transactions cannot execute. Stop dapps and discard their pending submission jobs before using the reset ledger.

If neither condition is met, keep sends blocked and recover the missing transaction history first. The wallet does not clear this flag automatically. Do not erase uncertain hashes or change their outcomes to bypass the block.

### Preserve storage, stop the worker, and clear only the flag

This is an advanced Chrome repair for this unpacked extension. Do not use `chrome.storage.local.clear()`, remove `wallet`, or replace its `envelope`. Keep the encrypted storage backup private; it includes account and transaction metadata and permits offline password guesses.

1. Lock the wallet. Close all wallet windows, approval windows, and connected dapp tabs. In `chrome://extensions`, note the extension ID.
2. Open `chrome-extension://EXTENSION_ID/favicon.svg` in a tab, replacing `EXTENSION_ID`. This bundled image is an extension-origin page without wallet scripts. Open that tab's DevTools Console. Run this code to download the current storage without printing its contents:

   ```js
   await (async () => {
     const backup = await chrome.storage.local.get(null);
     const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
     const url = URL.createObjectURL(blob);
     const link = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
     link.href = url;
     link.download = "thruput-encrypted-storage-backup.json";
     document.documentElement.append(link);
     link.click();
     link.remove();
     setTimeout(() => URL.revokeObjectURL(url), 60_000);
   })();
   ```

3. Confirm that the backup file was saved. Keep a separate copy before repair. Do not paste it into logs, issue reports, or chat. In the same Console, run `await chrome.alarms.clear("lock")` to remove the old lock timer.
4. Open `chrome://serviceworker-internals` in another tab. Find this extension's `worker.js` and click **Stop**. Close any worker inspection window and confirm that the worker is stopped. Keep the image tab open, but do not open the wallet or dapps until the edit is complete. If the worker restarts, stop it again before continuing.
5. Only after satisfying the outcome/reset conditions above, run this code in the image tab's Console. It changes only `recoveryBlocked`; it preserves the envelope and every remaining recovery hash:

   ```js
   await (async () => {
     const { wallet } = await chrome.storage.local.get("wallet");
     if (!wallet || wallet.recoveryBlocked !== true || !Array.isArray(wallet.outgoing))
       throw new Error("Unexpected storage. Stop and review the backup.");
     const envelope = JSON.stringify(wallet.envelope);
     const outgoing = JSON.stringify(wallet.outgoing);
     await chrome.storage.local.set({ wallet: { ...wallet, recoveryBlocked: false } });
     const saved = (await chrome.storage.local.get("wallet")).wallet;
     if (JSON.stringify(saved.envelope) !== envelope || JSON.stringify(saved.outgoing) !== outgoing)
       throw new Error("Storage changed during repair. Stop before using the wallet.");
   })();
   ```

6. Close the image tab and DevTools. Reload the extension from `chrome://extensions`, then open and unlock the wallet. Confirm that its accounts and retained hashes are present. If the recovery notice returns, storage still contains malformed recovery data: keep sends blocked and review the preserved backup. Use **Check status** for retained hashes and acknowledge only records you have reviewed. Reconnect dapps explicitly when recovery is complete.

## Dapp Provider

The in-page provider is announced as the `CustomEvent.detail` of `groundhog:announceProvider`, initially and in response to `groundhog:requestProvider`. It coexists with other providers; no global singleton is overwritten. Use `discoverWalletProviders` from `@groundhogchain/client/provider` in the dapp.

Provider identity: `dev.groundhog.wallet`, name `Thruput Wallet`, contract version `1.0.0`. The display-name change does not change provider IDs, storage or vault keys, or messaging protocols.

Supported SDK `ProviderRequest` methods:

- `connect`: opens an account-selection approval and returns the origin-authorized session.
- `getSession`: returns a session with no accounts when locked or unconnected.
- `disconnect`: revokes this origin's account grant.
- `signTransaction`: validates canonical unsigned XDR, exact account authorization, DefaultWallet root, and network; opens a review; returns `{ signedTransaction, hash }`. It never broadcasts.
- `submitTransaction`: broadcasts only previously approved identical signed bytes bound to this origin, account, and network. It never signs.

Accounts have canonical `0x`-prefixed 32-byte addresses and public keys, plus decimal string nonce `"0"`. Session network hashes are 64 lowercase hex characters without `0x`. `change` listeners receive only changed origin-authorized session snapshots, not UI refresh notifications or signature completion events. Connect and disconnect deliver their session changes before resolving the provider request, so an adapter created immediately after connection does not receive a late connection event. Disconnect and revoke affect only the requesting origin. Provider errors use the SDK's numeric error codes.

Reviews decode DefaultWallet execute/deploy and recognized ERC20 transfer calldata. Root address, calldata, gas, expiry, nonce, calls, and deployment bytes remain visible. **Not simulated** is intentional: decoding cannot predict downstream contract effects, validate token legitimacy, or guarantee execution success.

The native DefaultWallet implementation currently permits at most 16 calls. Signed XDR is capped at the SDK's 1 MiB boundary; unsigned requests reserve the actual 76 bytes needed for the Ed25519 signature wrapper.

## Security Model

- BIP39 mnemonic generation uses browser cryptographic randomness. Versioned derivation is SLIP-0010 Ed25519, `m/44'/1'/index'`, no BIP39 passphrase, account-address nonce explicitly zero. Removed indices are not reused. Imported keys are 32-byte Ed25519 seeds.
- Vault format 1 uses WebCrypto PBKDF2-SHA256 with 900,000 iterations and AES-256-GCM. Each write generates a fresh 32-byte salt and 12-byte IV. Associated data is `groundhog-wallet:vault:1`. Unsupported versions are rejected.
- Only encrypted secrets persist. Decrypted secrets and password stay in worker memory for at most ten minutes after unlock. Worker restart always locks. JavaScript strings cannot be reliably zeroized; this is not hardware-backed key isolation.
- Chrome local and session storage access is restricted to trusted extension contexts before processing messages. Session storage never holds keys. Token metadata, airdrop nonces, and signed approvals persist locally. Account grants exist only in worker memory; legacy persisted grants are discarded at startup. A canceled connection cannot regain authority after a cleanup-write failure or worker restart.
- Untrusted page messages pass through a MAIN-world bridge and isolated content script. The worker derives origin from Chrome's sender, rejects subframes, opaque origins, and non-HTTP(S) pages, validates bounded request schemas, and exposes no key export or generic RPC method to pages.
- Approval windows receive only a random ID in their URL. Confirmation checks the exact approval tab, original document, origin, account, network, and transaction. A request reserves its bounded approval slot before asynchronous preflight; cancellation is bound to its document and request ID even before a popup exists. Navigation, tab/window closure, timeout, cancellation, and lock fail closed. Pending approvals are intentionally not restored after worker restart.
- Signed approvals persist before signatures are returned, but are single-use permissions, not a recovery journal. Only the latest approval per origin/account/network tuple is retained, with a global limit of 16 approvals and 6 MiB of serialized approval storage. Submission consumes the permission durably before broadcast, including ambiguous failures. Lock, worker restart, revocation, network changes, and account-session changes retire affected permissions; reconnecting does not reauthorize old signed bytes. Revocation cannot retract signatures already shared or reverse a broadcast already started.
- Storage updates are serialized copy-on-write transactions: failed writes do not replace committed in-memory state. Recovery hashes are separate from approval permissions and survive their invalidation.
- The build bundles all scripts and fonts locally. No remote code, inline script, eval, or remotely fetched font is required.

## Files and Verification

| File                              | Responsibility                                                   |
| --------------------------------- | ---------------------------------------------------------------- |
| `src/vault.ts`                    | Encryption, mnemonic derivation, account construction            |
| `src/policy.ts`                   | Untrusted request validation and sender policy                   |
| `src/transactions.ts`             | Root/auth validation, review decoding, network signing           |
| `src/network.ts`                  | Fixed RPC endpoints, portfolio, transfers, airdrop result policy |
| `src/worker.ts`                   | Trusted UI operations, sessions, approval lifecycle, persistence |
| `src/inpage.ts`, `src/content.ts` | Discovery and request/reply bridge                               |
| `src/ui.tsx`, `src/ui.css`        | Popup and approval UI                                            |

Unit tests cover vault tampering and wrong passwords, derivation invariants, strict bridge policy, account authorization, network-bound signatures, exact-byte submission, airdrop execution outcomes and durable retry nonce, navigation/window cancellation, and worker restart. Live chain execution and a full Chrome approval walkthrough are separate acceptance checks, not implied by unit tests.

`npm run build && npm run test:browser` runs the real SDK adapter against the unpacked extension and a running localnet. It creates a temporary isolated Chromium profile, requests test HOG, connects, prepares/signs, persists the result in the dapp, submits through the same adapter, verifies the receipt, rejects repeated submission, and checks popup-close recovery. Set `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`. This test transfers newly airdropped test funds only.

For an isolated browser check without a node or funds, run `npm run test:browser -- --connect-only` after building. A local proxy returns mock identity and balance responses and blocks other RPC methods. The check verifies the Thruput display name, stable provider ID, Chrome icon sizes, and the lock → wrong password → unlock → explicit connection approval flow. It also verifies change-event ordering with immediate SDK preparation, preflight cancellation, failed connection cleanup followed by an actual worker restart, and account-scoped balance refresh after a simulated airdrop. The airdrop response is injected in the disposable worker and never reaches a node. UI-only fixtures cover stale portfolio errors and transfer preparations invalidated by account changes, external network changes, or lock.

Set `WALLET_SCREENSHOT_DIR=/tmp/thruput-wallet-screenshots` on that command to capture 400px and 800px layouts. Screenshots cover onboarding, restore, settings, portfolio, send, unlock, errors, keyboard focus, and connection approval. Separate presentation-only fixtures cover signature review, pending/failed transfers, unavailable balances, and loading with reduced motion. Fixtures cannot sign or write storage. Captures reject populated password/phrase fields and visible recovery backups. The temporary browser profile is removed when the check finishes.

During implementation, Chromium unpacked-extension checks also passed: wallet creation, 24-word recovery backup with reauthentication, hiding the backup, lock, provider discovery, connection approval, transaction review and signing, and locked-submit rejection. A live localnet airdrop and a one-base-unit HOG self-transfer both confirmed. The 400px popup and wider extension-page layouts were checked for horizontal overflow. Devnet and non-native token transfers still need deployment-specific acceptance testing.
