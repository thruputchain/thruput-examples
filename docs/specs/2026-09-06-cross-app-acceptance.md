# Cross-App Acceptance Record

Spec: [2026-09-06 integration](2026-09-06-integrate-amm-swap-token-launchpad.md), phase 4.
Execution: 2026-09-07 UTC. Result: **Final cross-app acceptance passed**.
The live journey and both suites were rerun after the final review corrections
through `f9e4667`. Independent re-review found no remaining high/medium findings.
The phase-4 harness did not change application logic or SDK versions; later
workflow and network-safety corrections are listed below. The provisioning
prerequisite is documented separately.

## Command And Tools

From `apps/swap`, with both dependency trees installed:

```sh
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
name: Cross App 1788754826912
symbol: XAPP
token: 0xa0ef11150dd805d6db541f71822e48fc8a27a27a2ee7f5e14358453ba8804648
counter: 0xbb13e3a40c439f9252c49088f8d69a9472426167142ca34ace6db20fcb5ed01d
creator: 0xa343ead3ff7bf8c93f9a9f37414c014730a03a8edddd142a7c0b39a45b598c2a
handler: 0x6fc453dea719441afaae28b930ad7b84baf4112fd6302b16026af8cdef715ed4
driver: 0xeb15942db21a6eb2eba7dbfc6b366ac4aa439da4168fc6caa2342dba2ad97198
LP token: 0x368fdbd0ad08ec31f39542d55772f23b2bb20c444b289d81bc7aa4baf46dbe29
reserve0 / reserve1: 10000000 / 10000000
Alice LP balance: 9999000
```

## Suites And Limits

After live acceptance, the command ran all three required commands in each app:

| App | `npm test` | `npm run typecheck` | `npm run build:production` |
| --- | --- | --- | --- |
| Swap | 68 files / 797 tests passed; 5 files / 6 tests skipped | PASS | PASS |
| Launchpad | 26 files / 400 tests passed; 1 file / 1 test skipped | PASS | PASS |

Both dependency audits reported zero vulnerabilities.

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

## Final Review Corrections

- Preserve reviewed pool intent while waiting for account locks and require explicit recovery when another tab creates a saved workflow.
- Preserve active funded creation across network mismatch, timeout, transport failure, or malformed identity responses; do not repeat funding after connectivity returns.
- Verify network identity before cleanup, recovery observation, and new writes. Preserve uncertain transaction evidence on failed checks.
- Allow safe archival under an obsolete workflow's persisted deployment identity and expose pre-hash factory-cleanup recovery.
- Freeze launchpad inputs during review and display the saved workflow's authoritative token intent.
- Check the token indexer's network before scans and immediately before page commits; reject runtime network drift, including empty pages.
- Align combobox accessible names with their visible search labels.

Each correction has regression coverage. Independent re-review verified the
previous findings, and the complete live journey passed again afterward.

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
