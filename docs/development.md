# Development checks

Start with [Getting started](getting-started.md). Run commands from the repo
root. This page is for contributors; none of the full-suite commands is needed
to understand your first example.

## Focused checks

```sh
cargo test -p fibonacci --locked
cargo test -p counter --locked --test test
npm run typecheck
npm test
```

The first two run native contract tests without a node. Root typechecking covers
the apps, shared seeding, and client examples. Root `npm test` runs app and seed
tests plus Linux process-group cleanup tests; it does not start a node.

## Rust test categories

| Kind | Command | What runs |
| --- | --- | --- |
| Native | `cargo test -p <crate> --locked` | Contract code in the SDK test environment; no node |
| RV32 | `thruput test -p <crate>` | Compiled RV32 artifact in the mock executor; Counter, ERC20, Speedex |
| RPC | `thruput test --integration -p <crate>` | Real signed transactions on an ephemeral node; Counter and ERC20 |
| Swap guest | `bash scripts/swap-test-guest.sh` | Native tests with guest collaborator contracts |
| Live scenarios | See [script index](../scripts/README.md) | Testkit scenarios and benchmarks with separate prerequisites |

Native tests of the small contracts are the fastest starting point. RPC tests
are separate Cargo targets. RV32 and testkit tests marked `#[ignore]` are skipped
by a plain native run; a skipped test does not prove the guest/live path works.

For the whole Rust workspace:

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --no-deps --locked -- -D warnings
cargo fmt --check
```

For all contract check categories, install `jq` and the matching runtime, then:

```sh
export THRUPUT_DEVNODE_BINARY="$(thruput toolchain which)"
bash scripts/check-contracts.sh
```

The `interfaces/`, `helpers/`, and `engines/` directories contain supporting
libraries. The `sim-fixtures/` directory contains simulator workloads, including
caller-counter, calldata, and nnint-stress. These are not introductory contracts.

## TypeScript and browser checks

```sh
npm ci
npm run typecheck
npm test
npm run build --workspaces
npm run test:browser
```

Browser fixtures use Chromium at `/usr/bin/chromium` unless `CHROMIUM_PATH` is
set. To install the browser used by CI:

```sh
npx --no-install playwright-core install chromium
export CHROMIUM_PATH="$(node --input-type=module -e 'import { chromium } from "playwright-core"; console.log(chromium.executablePath())')"
```

On Linux, Playwright's `--with-deps` installation option can also install system
libraries when permitted. Fixture checks cover wallet controls, layout, token
selection, and network guards; they do not sign real wallet transactions.

## Live client and app checks

These runners use Linux process groups and `/proc`. They start isolated nodes,
use temporary state, and leave the developer's app environments alone.

```sh
export THRUPUT_CLI="$(command -v thruput)"
export THRUPUT_DEVNODE_BINARY="$(thruput toolchain which)"
npm run examples:generate
npm run test:examples
```

The example runner executes all small client scripts, including deployment,
event reads, and batch rollback. It needs no browser or running app server.

For the larger app checks:

```sh
npm run generate:contracts --workspaces
npm run build --workspaces
npm run test:counter
npm run test:seed
npm run test:batching
```

| Command | Coverage |
| --- | --- |
| `test:counter` | Fresh deployment, concurrent transactions, keyboard input, reconnect/outage behavior; requires Chromium |
| `test:seed` | Indexed tokens, balances, liquidity, scope checks, repeatability |
| `test:batching` | Atomic batches, rollback, nonce retry, pool creation, LP ownership, queued swaps |

Use CLI **0.29.0** and runtime **0.1.31-rc.3** for this release set. Rebuild
artifacts and bindings together. `SEED_TEST_ARTIFACT_ROOT` and
`BATCH_TEST_ARTIFACT_ROOT` override their respective artifact roots;
`SEED_TEST_DEFAULT_OWNER=1` selects tool-account ownership in the seed test.
`THRUPUT_E2E_HOGD_PROTOCOL` is only for an explicitly compatible protocol build,
not a workaround for a CLI/runtime schema mismatch.

Live runners print evidence paths. The seed test retains its state for diagnosis.
Freighter browser approval flows require separate acceptance testing.

## CI and deployment configuration

CI checks Rust dependencies, workflow syntax, Rust tests, frontend types/tests,
builds, browser fixtures, and live client/app checks. Native/live jobs require
Cargo registry credentials; npm jobs require GitHub Packages read access. Grant
the moved repository Actions access to the packages or configure `NPM_TOKEN`.
The existing Cargo secret is named `GROUNDHOG_REGISTRY_TOKEN`; its name is an
external configuration detail, not a package import.

Hosting services such as Railway need package-read credentials during install.
Keep credentials outside source control. App READMEs describe runtime settings,
registry databases, public artifacts, and deployment commands.

## Compatibility and generated files

Configuration uses `THRUPUT_*` and `VITE_THRUPUT_*`; the browser proxy is
`/thruput-rpc`. Some wire names and saved app workflow identifiers keep their old
names for compatibility. Do not rename them as a text-only cleanup.

Regenerate bindings with `npm run examples:generate` or the app's
`generate:contracts` command. Do not hand-edit generated files. Rebuilt artifacts
are not automatically deployed to existing addresses. Preserve the earlier
checkout/artifacts for historical deployments or unresolved transactions.

The old `tests/token-factory-ts` harness is outside the current npm workspace
and uses historical pins. Its disposition and deeper app/seeder simplification
are deferred in [REPOSITORY_REVIEW.md](../REPOSITORY_REVIEW.md).
