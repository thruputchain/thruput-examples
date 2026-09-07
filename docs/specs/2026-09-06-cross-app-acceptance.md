# Cross-App Acceptance Record

Spec: [2026-09-06 integration](2026-09-06-integrate-amm-swap-token-launchpad.md), phase 4.
Execution: 2026-09-07 UTC. Result: **Live phase 4 acceptance passed**.
Final review identified workflow issues to be fixed separately. This record
documents the exercised live journey, not final integration sign-off or a claim
that all blockers are resolved. Those review follow-ups remain pending.
No application/browser/server logic or SDK versions were changed in phase 4;
the only provisioning prerequisite is described below.

## Command And Tools

From `apps/swap`, with both dependency trees installed:

```sh
TMPDIR=/tmp/opencode \
GROUNDHOG_CLI="$HOME/Work/groundhog-rpc/target/debug/groundhog" \
GROUNDHOG_DEVNODE_BINARY="$HOME/.local/share/groundhog/hog-devnode/hog-devnode" \
GROUNDHOG_E2E_HOGD_PROTOCOL=hogp/4166df9d6a5411d \
npm run test:e2e:cross-app
```

Groundhog 0.15.1; hog-devnode 0.1.27-rc.1; Node 22.23.1; Chromium
151.0.7922.173; existing `playwright-core` 1.63.0. Swap used client/protocol
0.6.0/0.11.0; launchpad used 0.4.0/0.8.0. Actual compatibility was exercised,
not inferred from versions. The runtime manifest confirmed
`hogp/4166df9d6a5411d`; independent RPC network reads matched both configs.

## Live Results

| Gate | Actual evidence |
| --- | --- |
| One ledger | Fresh node, dynamic RPC/app/service ports, three funded disposable users, sequential provisioning, separate token/pool SQLite databases. |
| Browser launch and handoff | Real review/launch; stored creation committed and verification complete; exact CTA href used the actual token address and only `tokenA`; real same-tab click. |
| Before indexing | Production token index used a delayed sync interval and returned no match. Swap showed live name, symbol, and 6 decimals; B and both amounts were empty. No review or signing occurred automatically. |
| Manual counter-token | Funded setup gJPY token was absent from the launchpad index but loaded live metadata and was accepted. |
| Create and seed | Explicit Review and Create; queued workflow recovered after navigation with conflicting presets, without preset previews or new writes; explicit Process liquidity queue delivered liquidity and navigated to pool detail. Eight browser transaction submissions across launch and pool workflow. |
| Chain verification | Independent SDK reads matched factory pool addresses and reverse-order `getPair`; both reserves were 10,000,000 base units; Alice received 9,999,000 LP base units. |
| Indexed discovery | After restarting indexing, actual Vite proxy and browser keyboard selection passed unique name, symbol, full/partial token address, and creator-address queries. Each browser query awaited its own HTTP response; labels matched live metadata. |
| Presets and rejection | Fresh two-token URL preserved reversed form order and both live previews. Malformed A preserved valid B; duplicate pair kept only A; manual duplicates blocked Review; authoritative review rejected the existing pool. |
| Faults | Stopped real registry produced unavailable discovery with manual live fallback. Separate Vite configurations with wrong registry factory and wrong RPC network returned 502; only network mismatch blocked live metadata/review. No mocked browser RPC was used in this run. |
| Both production servers | Built and started actual `server/main.ts` processes, not Vite preview. SPA/manifests served; CSP retained `connect-src 'self'`; no broad CORS; creation URLs redirected; no signing/input controls; transaction RPC returned 403. Same-origin browser discovery worked under CSP; invalid queries/repeated keys/methods were rejected with bounded, no-store, nosniff errors. |
| Secret exclusion | Production environments cleared disposable credentials; assets/manifests scanned for generated keys, derivation seed, and registry upstream origin before server startup and after final rebuilds. |
| Cleanup | Env/config fingerprints unchanged, including file mode, mtime, symlink identity and target content. Owned process groups and temporary keys/DBs/state removed. Separate SIGINT and SIGTERM tests exited nonzero and completed cleanup. Process inspection found no remaining harness services. |

Final-run public evidence (ephemeral ledger has been removed):

```text
network: 0000000000000000000000000000000000000000000000000000000000000000
name: Cross App 1788753270841
symbol: XAPP
token: 0xbf18c91806ba07ea99e43f6216760848d1df5ce3e5ab453f8a9abc7d0d5bf429
counter: 0x7d3816c3230a6283d98a18d67b2b4449d83c0bbc72362e1bba7725bf4a8e414d
creator: 0xa343ead3ff7bf8c93f9a9f37414c014730a03a8edddd142a7c0b39a45b598c2a
handler: 0x86078ee1ebe3071aa28bc62cadc357e26135b71c0b799700aa0969039b956ea7
driver: 0xf1181c993ac4a6ec65b3d58f85647f094ac6a48b9ff31fda054e03979ff9f7c9
LP token: 0xd04e5d51a1dc1175df950bba22999c0bcfadf51c9866a6fb8992029682776ca6
reserve0 / reserve1: 10000000 / 10000000
Alice LP balance: 9999000
```

## Suites And Limits

After live acceptance, the command ran all three required commands in each app:

| App | `npm test` | `npm run typecheck` | `npm run build:production` |
| --- | --- | --- | --- |
| Swap | 68 files / 766 tests passed; 5 files / 6 tests skipped | PASS | PASS |
| Launchpad | 26 files / 372 tests passed; 1 file / 1 test skipped | PASS | PASS |

The existing `npm run test:browser:tokens` also passed Chromium 320px touch and
desktop layout, keyboard focus return, duplicate choices, server filtering,
manual outage fallback, and controlled network-mismatch checks. That runner uses
fixtures; it is separate from the real-chain evidence above.

Normal suites retain their opt-in local-integration skips. The separate per-app
clean-ledger commands were not run as substitutes for cross-app acceptance.
Exhaustive synthetic pagination/Unicode/nullable metadata, cancellation races,
storage corruption, and alternate recovery branches remain unit/component/HTTP
suite coverage, not claims that this ledger contained every such case. Only
Chromium was browser-tested. SIGKILL cannot perform cleanup. Ignored contract
artifacts and secret-free `dist` outputs remain and refer to a now-removed ledger;
rebuild for the next deployment. No runtime manifest, private key, env backup,
SQLite database, or raw log is included in this record.

## Resolved Prerequisite

Two fresh-node runs stalled in launchpad `scripts/setup-local.ts` at factory
initialization: `wallet.waitForTransactionReceipt` timed out and the real RPC
reported `pending`. Deployments had succeeded. Reducing that setup script's gas
limit from 100,000,000 to 10,000,000, matching the browser wallets and Swap setup,
unblocked provisioning and repeated complete browser journeys. This is a
setup-only prerequisite, not a broad SDK upgrade or an application-logic fix.
Intermediate browser-runner failures were incorrect selectors for the existing
queue switch, successful detail-page navigation, and existing-pair error text;
the harness was corrected without changing those application behaviors.

Operator instructions: [cross-app recipe](../cross-app-operations.md).
