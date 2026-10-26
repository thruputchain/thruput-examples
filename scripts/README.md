# Repository tools

These scripts support development and verification. For small runnable SDK
examples, start at [examples/typescript](../examples/typescript/README.md).

Run all commands below from the repository root. Install the toolchain with
[Setup](../README.md#setup). Shell tools use `thruput` on
`PATH`; app setup accepts `THRUPUT_CLI`. Set both to the same CLI release.

## Contract builds and checks

| Command | Purpose | Requirements / effects |
| --- | --- | --- |
| `bash scripts/build-guest.sh` | Build all guest artifacts | Rust, CLI, `jq`; writes `target/thruput/` |
| `bash scripts/check-contracts.sh` | Native tests, guest builds/tests, RPC tests, Clippy, rustfmt | Full Rust/CLI/runtime toolchain; starts temporary nodes; expensive compared with one contract test |
| `bash scripts/integration-tests.sh` | Counter and ERC20 RPC tests | CLI and matching runtime; builds artifacts and uses ephemeral nodes |
| `bash scripts/check-thruput-version.test.sh` | Check CLI minimum-version parsing | Bash only; no node |
| `bash scripts/swap-test-guest.sh` | Build Swap artifacts and run guest tests | Rust and CLI; no external RPC required |

`check-thruput-version.sh` is a helper used by binding generators. It is not a
platform example. `build-guest.sh` and `check-contracts.sh` support `CARGO_UNLOCK`
for deliberate lockfile updates; normally leave it unset.

For a quick check, prefer `cargo test -p fibonacci --locked` over the full suite.
See [Checks](#checks) below for the test categories.

## Advanced live scenarios and benchmarks

Set `THRUPUT_DEVNODE_BINARY="$(thruput toolchain which)"` for live scenarios.

| Command | Purpose | Important effects |
| --- | --- | --- |
| `bash scripts/permit-live.sh` | Sign an off-chain permit and relay it on a devnode | Builds token/wallet/relayer artifacts; runs an ignored live test |
| `bash scripts/swap-sim.sh` | Multi-agent Swap liquidity scenario | Builds Swap artifacts; runs an ignored live test |
| `bash scripts/swap-gas-calibrate.sh` | Measure per-request crank gas, alone and in a batch | Overwrites the driver artifact with an instrumented build; rebuild normally afterward |
| `bash scripts/speedex-bench.sh` | Measure exchange quality and on-node gas | Temporarily edits the Speedex manifest; leaves an artifact with a different memory budget; writes CSVs under `target/` |
| `python3 scripts/speedex-plot.py` | Plot benchmark CSVs | Python and matplotlib; writes figures under `target/speedex-bench/` |

The live/benchmark shell scripts use Bash features beyond the default Bash 3.2
on older macOS installs. Use a current Bash. Run them one at a time when they
write the same artifacts. Set `NO_BUILD=1` only when the required matching
artifacts already exist. The Speedex benchmark also accepts `NO_GAS=1` to run
only native quality measurements and plots.

These tools are not required for a first contract or client example.

## App tooling

App entrypoints live with their app:

```sh
npm run setup:local --workspace apps/counter
npm run setup:local --workspace apps/token-launchpad
npm run setup:local --workspace apps/swap
```

Each command generates bindings, deploys fresh infrastructure, and writes app
configuration. Read the app README before running it against an existing setup.
`generate:contracts` builds artifacts and regenerates bindings without deployment.

[`seed/`](seed/README.md) is shared **app tooling**, not a beginner SDK example.
Use the app commands rather than invoking its implementation directly:

```sh
npm run seed --workspace apps/token-launchpad
npm run seed --workspace apps/swap
```

Both apps must use the same local node. Set `SEED_RECIPIENT` to your public
wallet address. Each command creates new tokens; Swap also creates a new pool.
No app server, saved signer, or recovery journal is needed. A failed run stops
and prints its progress and transaction hashes; another run creates new assets.

## Checks

Run focused checks first:

```sh
cargo test -p counter --locked --test test
npm run typecheck
npm test
npm run build --workspaces
```

Native Rust tests run without a node. `thruput test -p counter` runs the guest
artifact; `thruput test --integration -p counter` runs RPC tests on an ephemeral
node. Use `cargo test --workspace --locked`, `cargo fmt --check`, and
`cargo clippy --workspace --all-targets --no-deps --locked -- -D warnings` for
workspace-wide Rust checks. Ignored live/guest tests need their own commands.

`npm run test:browser` uses Chromium fixtures without signing. Set
`CHROMIUM_PATH` if it is not at `/usr/bin/chromium`, or install it with
`npx --no-install playwright-core install chromium` and use the installed path.

For live checks on Linux (process groups and `/proc` are required):

```sh
export THRUPUT_CLI="$(command -v thruput)"
export THRUPUT_DEVNODE_BINARY="$(thruput toolchain which)"
npm run examples:generate
npm run test:examples
npm run generate:contracts --workspaces --if-present
npm run build --workspaces
npm run test:counter
npm run test:seed
npm run test:batching
```

These use isolated nodes and temporary state. Counter checks require Chromium.
`test:counter` checks development-signed updates, keyboard bursts, signer top-up,
and recovery after an RPC outage.
Seeding checks fresh assets on rerun, balances, reserves, and indexing. Batching
checks atomic rollback, storage top-ups, and pool operations. Freighter browser
approval flows require separate acceptance testing.

CI runs these checks with registry credentials. Grant repository Actions access
to the npm packages; npm jobs use `github.token`. The Cargo registry secret is named
`GROUNDHOG_REGISTRY_TOKEN`. Rebuild artifacts and bindings together; installing
packages does not upgrade contracts already deployed to a node.
