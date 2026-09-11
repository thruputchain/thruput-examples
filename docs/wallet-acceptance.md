# Wallet Extension Acceptance

This harness runs a real unpacked Chrome extension against a fresh local Groundhog node. It provisions infrastructure only, then creates and funds the user wallet through the extension UI. All token launches, pool creation, swaps, and liquidity transactions require clicks in actual extension approval windows. No injected mock provider or setup-generated browser key is used.

## Run

The simplified apps use the root npm workspace: run `npm ci` once, then
`npm run typecheck`, `npm test`, and `npm run test:browser`. Both development
servers now include their registry APIs. `npm run test:wallet` invokes this
live harness, and `npm run test:seed` runs the shared demo-seed acceptance.

After the simplification, typechecks, 883 Swap tests, 381 Launchpad tests, 31
seed-tool tests, real development API tests, controlled production builds, and
both-app Chromium fixture checks pass. Fresh-ledger acceptance was attempted
but stopped before provisioning: the available CLI expects
`endpoints.schedulerGateway`, absent from the installed devnode's manifest.
Use a compatible CLI/devnode pair before treating the earlier live results below
as acceptance of this refactor. A protocol-token override does not fix that
schema difference.

From the repository root, use a compatible Groundhog CLI and devnode pair. The following combination was tested on this workstation:

```bash
GROUNDHOG_CLI="$HOME/Work/groundhog-rpc/target/debug/groundhog" \
GROUNDHOG_DEVNODE_BINARY="$HOME/.local/share/groundhog/hog-devnode/hog-devnode" \
GROUNDHOG_E2E_HOGD_PROTOCOL=hogp/236f9821a6244af \
node scripts/test-wallet-extension.mjs --build-extension --devnet
```

`--build-extension` builds the current extension source into the harness's temporary directory. It does not overwrite `apps/wallet-extension/dist`. Omit it to test a snapshot of the existing `dist` instead. An older extension build can fail after signing with `Wallet session changed or adapter was disposed`; use a build containing the sign-event invalidation fix.

`--devnet` explicitly enables the external smoke: a read-only identity probe, followed only on success by an extension network toggle and one test-HOG airdrop to a fresh, separate derived account. Omit it for local-only testing. The command never sends real funds or uses an existing wallet.

Prerequisites:

- Node.js 22 with `util.parseEnv` support.
- Installed dependencies in Swap, Launchpad, and the wallet extension, including the built local sibling SDK with `/provider` and `/wallet` exports.
- Playwright in the extension dependencies, or `playwright-core` in Swap's dependencies. This workstation has the latter.
- Extension-capable Chromium. The default is `/usr/lib/chromium/chromium`; set `CHROMIUM_PATH` elsewhere. Prefer the browser binary over a desktop wrapper that loads user flags or extensions.
- Compatible contract artifacts in `target/groundhog`: `erc20`, `swap_factory`, `swap_router`, `swap_handler`, `swap_driver`, `standard_token`, and `standard_token_factory`, each with an `.rv32a` suffix. Set `WALLET_ACCEPTANCE_ARTIFACT_ROOT` to use another prepared artifact directory. The harness does not rebuild contracts.
- `/tmp/opencode` must exist and be writable.

`GROUNDHOG_E2E_HOGD_PROTOCOL` is optional when the CLI's compiled protocol matches the devnode. A protocol override cannot repair incompatible wire formats. The older CLI at `$HOME/.cargo/bin/groundhog` failed with the installed devnode here, including a scheduler RPC failure when its protocol token was overridden. Use the compatible sibling CLI above rather than changing or stopping the user's node.

## Checks

1. Start one fresh node with `--port 0 --dev-account-count 0`. The faucet remains; no user wallets are bootstrapped.
2. Run both infrastructure-only setup scripts with the node's full runtime storage-cost manifest and independently read zero factory pairs. Require the public artifact filenames to be exactly `${hash}.json`, including the `0x` prefix; no mutable `erc20.json` or `standard-token.json` fallback is used.
3. Create an encrypted wallet, reveal its 24-word backup without capturing its words, hide the backup, and request local test HOG through the UI.
4. Connect Launchpad and create two uniquely named and symbolized tokens, each with six decimals and one million units. Require complete receipt, event, metadata, supply, and holder-balance verification for each token.
5. Connect Swap with the same account. Enter both launched addresses and ten units of each token, review, create the first pool, and approve each transaction, including automatic queue processing.
6. Independently verify exactly one factory pair, forward and reverse mappings, handler/driver/LP addresses, reserves of `10000000` raw units each, and a positive user LP balance.
7. Reload the pool page, reconnect, and recover the position without recreating it.
8. Reject a swap signature in the extension. Verify unchanged reserves, LP, and token balances. Retry explicitly, approve the swap and automatic crank, and verify changed reserves with unchanged LP.
9. Add liquidity through the UI and verify increased reserves and LP. Remove 25% through the UI and verify decreased reserves and LP.
10. Reject a new connection and verify read-only app state. Add an unfunded derived account, reconnect with both accounts, switch to its zero LP position and back, and verify unchanged chain balances and reserves.
11. Send a forbidden transaction-write request to each app's public RPC proxy and require HTTP 403.
12. Manually add the launched ERC20 in the wallet, fund its storage reserve with `0.01 HOG` through the wallet's native-token send UI, then review and send one ERC20 unit to the second derived account. Verify exact sender/recipient deltas of `1000000` raw units, unchanged pool state, and both confirmations after wallet-page reload.
13. Build both frontends in production mode with the real hash-named artifacts. Start copies of their unchanged production entrypoints without signing credentials. Require startup failure with the artifact missing, successful startup after restoring it, byte-exact HTTP artifact serving, matching public manifests, two indexed tokens/one indexed pool, rendered browser pages, successful network reads, and rejection of send/airdrop RPC methods.
14. Run the extension's vault and worker unit suites, including fixture-mnemonic derivation/restore and private-key import behavior. This is unit coverage, not a claimed browser restore/import journey.
15. With `--devnet`, probe `groundhog_networkInfo` once, verify the extension pins that identity after toggling, request test HOG once for a separate third account, and verify a confirmed hash and positive HOG balance. The probe is bounded to eight seconds and the airdrop wait to 65 seconds; failures are recorded as external blockers, never retried in a loop.

The app's verified launch state is read from browser storage as evidence, not written by the harness. Pool state and balances are read independently by `scripts/wallet-acceptance/chain.mts` using the generated contract bindings.

## Isolation

Each invocation uses a private temporary directory, isolated XDG directories, a new persistent Chromium profile, and its own process groups. The node and Vite servers use dynamically allocated loopback ports. Only those owned processes are terminated.

The extension hardcodes `http://127.0.0.1:9545`, including its CSP. A browser-only HTTP proxy redirects that exact origin to the fresh node. The proxy also allows the temporary Vite and production app origins and rejects other destinations and HTTPS tunnels. With `--devnet`, the wallet's exact devnet origin is allowed only after the read-only probe succeeds and only for the final smoke. Chromium's loopback proxy bypass is disabled. This covers extension service-worker requests without binding port 9545, patching the extension, or sending test transactions to the user's node.

Setup receives temporary `SWAP_APP_ENV`, `LAUNCHPAD_APP_ENV`, and public-directory overrides. Vite receives the temporary `publicDir` and cache directory. Because each app's Vite config explicitly loads env files from its own root, the harness overrides every existing env-file key in the server/build process before applying this run's generated configuration. The live signing journey disables registries and discovery; production smoke enables registries but not cross-app discovery. Neither `.env.local` nor app build output is written. Both app env files are fingerprinted before and after the run.

Child processes inherit only an allowlist of OS environment variables plus explicit harness settings. Production builds and servers do not receive bootstrap-manifest paths or signing credentials. Builds are scanned for the generated password, known bootstrap seed, raw upstream RPC URL, and env files. Production servers run from temporary code copies with symlinked installed dependencies and private temporary databases. They retain the apps' production listener behavior (`0.0.0.0`) on temporary ports; unlike Vite, these brief smoke listeners are not loopback-bound. Their RPC proxies remain read-only.

## Evidence And Cleanup

The command prints an evidence directory such as `/tmp/opencode/wallet-acceptance-XXXXXX/evidence`. It retains:

- `result.json`: outcome, checks, tool versions, full public cost model, extension worker hash, public addresses, approval kinds, chain snapshots, production results, and devnet outcome.
- Token, pool, swap, liquidity, and production-page screenshots, when those stages complete.
- Sanitized child-process logs.
- App-only failure text, screenshot, and workflow records on failure.

The harness never records extension-page screenshots, browser traces, real mnemonic words, passwords, or private keys. Passwords and known bootstrap secrets are redacted from logs; 32-byte hex values in text logs are also redacted. Public addresses, transaction hashes, and narrowly selected transfer-status diagnostics remain in structured evidence. After verifying all owned process groups have exited, `finally` removes the temporary browser profile, node/XDG state, generated env files, code artifacts, production copies/databases, and copied extension, whether acceptance passed or failed. If group termination cannot be verified, the command exits nonzero and retains the private temporary state rather than falsely reporting cleanup. Retained evidence is inside a private directory.

Each wait is bounded, and a 15-minute watchdog closes the browser and terminates owned process groups. SIGINT and SIGTERM trigger the same shutdown. Group IDs come only from detached processes launched by the harness; launcher `close` events do not remove live groups. Cleanup shares concurrent termination requests, sends SIGTERM, waits up to two seconds, escalates to SIGKILL, and waits up to three more seconds for a signal-0 probe to return ESRCH. A reused leader PID with a different Linux `/proc` start time is not signaled. `result.json.processGroups` records spawned groups, verified exits, and remaining groups. SIGKILL of the harness itself or machine failure cannot run JavaScript cleanup.

Run the standalone Linux cleanup regression without Chromium, apps, or a node:

```bash
node --test scripts/wallet-acceptance/process-groups.test.mjs
```

It verifies that an exited launcher with closed output still has its TERM-resistant descendant killed, that concurrent cleanup calls wait for the group to disappear, that another registry's detached group is untouched, and that failed spawns do not create ownership records. All process fixtures are created by the test; it does not search for or signal user processes.

## Results And Limits

The subsequent [full workstream review](wallet-workstream-review.md) records
the latest fixes and verification. Its final local/production run passed all
21 checks; evidence is `/tmp/opencode/wallet-acceptance-449BPp/evidence/`.
Connection grants now last only for the extension worker's lifetime; after a
worker restart, unlock and approve the site again. Vault and transaction
recovery data remain persistent.

After the process-group cleanup fix, the local harness passed with `--build-extension` at `2026-09-08T04:46:47Z`: 21 acceptance checks, zero blockers, and all 24 owned process groups verified exited with zero remaining. Devnet was not requested. All three standalone cleanup regression tests also passed. Evidence: `/tmp/opencode/wallet-acceptance-6rqneL/evidence/result.json`; only its evidence directory remained after cleanup.

Before that cleanup fix, the expanded journey passed twice consecutively with `--build-extension --devnet`, after the immutable filenames, full runtime cost manifest, production validators, and launch reserve stale-read fixes. The later of those runs completed at `2026-09-08T04:18:12Z` in about 75 seconds with 22 checks and zero blockers. Evidence: `/tmp/opencode/wallet-acceptance-pqW72x/evidence/result.json` and `/tmp/opencode/wallet-acceptance-8eFlym/evidence/result.json`.

These runs used Groundhog CLI `0.16.0-rc.1`, devnode `0.1.27-rc.4`, Chromium `151.0.7922.173`, and Node `22.23.1`. The LP balance moved from `9999000` to `10908090` after adding liquidity and `8181068` after removing 25%, in raw units. The wallet transferred exactly one launched token to the second account. Production indexed two tokens and one pool, and the two extension unit files passed all 23 tests.

Current artifact paths are:

- Launchpad: `contract-artifacts/0x2ce1fb17d0eaae09ed8ded2514f660a221d233ce60924bdcebb95a704124d7ea.json`.
- Swap: `contract-artifacts/0x152d5e4635c5322cb1fbc75e7584cd6565d8e4802c04e9c4e9b75b4e7fb90776.json`.

The harness derives both names from each run's setup output rather than hardcoding these hashes.

Devnet was reachable at `http://44.236.180.135:8545`, with network hash `0xabccfe796b3065d9f9985be6db9e2d01880f29d990447d9ea596a97009e73642`. The final throwaway account showed a confirmed airdrop and `9.9998766 HOG`. No devnet blocker remained in the successful runs. Devnet is optional: consult `result.json.devnet.status` separately from the local/production exit status if the external endpoint is unavailable.

The earlier launch reserve stale-read error did not recur after the app fix. A separate reserve limitation was exposed by the new transfer test: sending to a new holder after pool operations, without more token storage funding, produced `recentFailure` / `boundsExceeded` at the token address and no recipient credit. Evidence is retained at `/tmp/opencode/wallet-acceptance-IYvONT/evidence/result.json`. The final journey explicitly funds the token reserve before submitting that transfer; it does not silently retry an ambiguous transaction. The wallet now shows "Execution not yet confirmed," retains the hash and advisory across reopening, and explains that token contracts may require a HOG storage reserve. Checking status never resubmits.

After the final cancellation-race fixes, SDK size-bound fix, and removal of retired persona harnesses, a further `--build-extension` run passed all 21 local/production checks with zero blockers. Evidence: `/tmp/opencode/wallet-acceptance-r0EGr8/evidence/result.json`. Devnet was not requested in this final local rerun; the separate successful devnet evidence above remains applicable. Final deterministic suites passed: SDK 523 tests (2 existing skips), extension 44, Swap 899, and Launchpad 487. Typechecks, SDK package checks, controlled production builds, and dependency audits passed.

This is development acceptance and a production-server/devnet smoke, not a security certification. It does not test remote production deployment, cross-app discovery, full browser restart/locked-wallet recovery, or resolution of an in-flight ambiguous transaction. Reload recovery covers a completed pool and persisted wallet transfer confirmations. Mnemonic restore and key import are unit-tested, not driven through browser onboarding. No real funds, user accounts, or existing local ledger are used.
