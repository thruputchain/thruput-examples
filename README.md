# groundhog-examples

Example smart contracts and applications for the [Groundhog SDK](https://github.com/groundhogchain/sdk_rs). Each
crate in this Cargo workspace demonstrates a specific SDK feature, from a minimal stateless contract
up to cross-contract calls, error handling, and event emission.

New to Groundhog? Start with [Getting Started](https://docs.groundhog.dev/start/getting-started/)
on the developer docs site, which walks through installing the CLI and scaffolding a project with
`groundhog new`. The [Build a Counter](https://docs.groundhog.dev/tutorials/build-a-counter/) and
[Build a Token](https://docs.groundhog.dev/tutorials/build-a-token/) tutorials cover the `counter`
and `erc20` crates here line by line.

## Examples

A suggested reading order for newcomers is `fibonacci` → `cross-call` → `events`, then the error-handling pair, then `cross-trait-throws` for catching an error across interface boundaries.

| Crate | Demonstrates |
|-------|--------------|
| [`counter`](contracts/counter/) | Storage (`NNInt`), an event, and a contract error in one small contract; the same contract `groundhog new` generates |
| [`fibonacci`](contracts/fibonacci/) | Minimal stateless contract: one method, one error type, one event |
| [`cross-call`](contracts/cross-call/) | Cross-contract call patterns via a generated client (`call`, `try_*`, error forwarding); calls `fibonacci` |
| [`events`](contracts/events/) | `#[derive(Event)]` with the full range of topic and payload patterns: payload-only, address topics, hashed topics, topics-only, multi-emit |
| [`error-handling-callee`](contracts/error-handling-callee/) | Producing error conditions (declared throws, undeclared errors, panics/faults) for callers to handle |
| [`error-handling-caller`](contracts/error-handling-caller/) | Catching, wrapping, and forwarding errors from a callee contract |
| [`multi-throws`](contracts/multi-throws/) | Declaring multiple error types with `throws(A, B)` |
| [`multi-impl-if`](interfaces/multi-impl-if/) | Defining contract interfaces as traits in a standalone crate |
| [`multi-impl`](contracts/multi-impl/) | One contract implementing multiple traits from a separate crate |
| [`mixed-impl`](contracts/mixed-impl/) | One contract exposing both an inherent (`notrait`) `#[contract]` impl and a trait `#[contract]` impl |
| [`cross-trait-throws`](contracts/cross-trait-throws/) | One contract implementing two traits with different `throws` types; a client on one catching the peer trait's error with `match_exn!` |
| [`erc20`](contracts/erc20/) | A fuller, realistic contract: an ERC20 token implementing an external interface trait, with `Map`/`NNInt` storage and optional `metadata` and `permit` features |
| [`permit-wallet`](contracts/permit-wallet/) | Off-chain authorization: an owner's wallet implementing `SignedOp`, turning an ed25519 signature made off-chain into a `PermitGrant` auth token the `erc20` consumes; the owner never submits a transaction |
| [`permit-relayer`](contracts/permit-relayer/) | Auth-token composition: a stateless contract that carries a signed permit or allowance clear from the wallet to the token in one frame, routing by the signed request, so anyone can submit it |
| [`sep41-token`](contracts/sep41-token/README.md), [`sep41-token-if`](interfaces/sep41-token-if/) | A port of Stellar's token interface, [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md), without its allowances or its name, symbol and decimals: its functions, arguments, events and behaviour, in an interface crate, and a token implementing it with an administrator's `mint` and `set_admin` |
| [`standard-token`](contracts/standard-token/), [`standard-token-factory`](contracts/standard-token-factory/), [`standard-token-factory-if`](interfaces/standard-token-factory-if/) | A fixed standard-token implementation, its factory, and the factory interface crate, with a [local launchpad](apps/token-launchpad/README.md) |
| [`swap-*`](contracts/swap-router/README.md) | A Uniswap V2-style pair with router, request queue, handler, lifecycle events, and a [local frontend](apps/swap/README.md) |
| [`speedex`](contracts/speedex/) | A [SPEEDEX](https://www.usenix.org/conference/nsdi23/presentation/ramseyer)-style batch exchange over several assets: offers aggregate into a commutative histogram, one transaction per batch computes clearing prices by tâtonnement, and settlement is per offer and order-free |

### Simulation fixtures

The crates under [`sim-fixtures/`](sim-fixtures/) are not pedagogical examples — they are contracts with specific workload shapes used as fixtures for testing the transaction simulator:

| Crate | Workload |
|-------|----------|
| [`caller-counter`](sim-fixtures/caller-counter/) | Per-caller counter exercising read-after-write storage patterns |
| [`calldata`](sim-fixtures/calldata/) | Calldata-heavy entry points |
| [`nnint-stress`](sim-fixtures/nnint-stress/) | NNInt-heavy writes with refund capping |

## Applications

| App | Purpose |
| --- | --- |
| [Counter](apps/counter/README.md) | Send concurrent counter transactions with buttons or keyboard input; uses a development signer |
| [Token Launchpad](apps/token-launchpad/README.md) | Create standard tokens and browse launches |
| [Swap](apps/swap/README.md) | Create pools, swap tokens, and manage liquidity |
| [Thruput Wallet](apps/wallet-extension/README.md) | Chrome wallet for localnet and devnet |

Each app README contains its setup, configuration, and testing instructions.
Counter, Swap, and Launchpad share one npm workspace and root lockfile. The wallet has an
independent install.

Game of Life (atomic and async worlds, frontend, indexer, and test fixtures) now
lives in [groundhogchain/gameoflife](https://github.com/groundhogchain/gameoflife).

### Install Swap and Launchpad dependencies

Use Node.js **22.13 or newer** and npm. The apps install the published
`@groundhogchain/client@0.11.0` package, including wallet capability discovery and
atomic batching, from GitHub Packages. The repository `.npmrc` selects the registry. Configure a PAT
with `read:packages` and access to the Groundhog packages in your npm user config:

```ini
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Set `GITHUB_PACKAGES_TOKEN` in your environment, then install from the repository root:

```sh
npm ci
```

Railway needs the same package-read authentication during dependency installation.
Provide the PAT through the build environment and npm auth configuration; never
commit its value. The deployment context needs only this repository.

Both apps expose `dev`, `build`, `start`, `typecheck`, `test`, `setup:local`,
`seed`, and `generate:contracts`. Select an app with
`npm run <command> --workspace apps/<app>`. Each dev server includes its registry
API and indexer. Setup creates empty infrastructure; seeding adds example assets.

For browser transactions, build and load [Thruput Wallet](apps/wallet-extension/README.md),
create or import a test wallet, and request test HOG. App RPC proxies are read-only;
the wallet signs and submits. These examples use test funds.

Counter uses the same dependency install, with a local development signer and
its own submission-capable RPC proxy. See its [setup guide](apps/counter/README.md)
for keyboard controls and the compatible CLI/devnode pairing.

All three apps use the same `setup:local` flow: `generate:contracts`, then
`tsx scripts/setup-local.ts`. All three also provide `setup:devnet`, which writes
`.env.devnet` for a fresh deployment on a pinned network.

### Application checks

Run from the repository root:

| Command | Coverage and requirements |
| --- | --- |
| `npm run typecheck` | All workspace apps and shared seeding TypeScript |
| `npm test` | App and seed unit/integration tests, plus Linux process-cleanup regressions |
| `npm run test:browser` | Chromium fixture checks for wallet controls, token selection, network guards, and page layout; no live node |
| `npm run test:wallet` | Real extension approvals through token launch, pool creation, swap, liquidity, transfer, and production-server checks on a fresh node |
| `WALLET_ACCEPTANCE_LEGACY=1 npm run test:wallet` | The same live journey through the legacy provider surface, with individual transaction approvals |
| `npm run test:batching` | Fresh-node atomic batches, rollback, token nonce retry, pool creation, LP ownership, and queued swaps |
| `npm run test:seed` | Fresh-node seeding, indexed tokens, balances, liquidity, and repeatability |
| `npm run test:counter` | Fresh-node counter setup, concurrent transactions, and real browser keyboard input; requires a built counter artifact and app |

Set `CHROMIUM_PATH` to your Chromium binary if needed. Browser fixtures default
to `/usr/bin/chromium`; the live wallet test defaults to `/usr/lib/chromium/chromium`.
Both live runners use Linux process groups and `/proc`. Install the wallet's
dependencies separately before running it; the command builds its source into a
temporary directory, so an existing extension `dist` is not required.

Live checks need a compatible CLI/devnode pair, built contracts, and matching
generated bindings: CLI `0.19.0` or newer with the hog-devnode it manages
(`0.1.29-rc.4`). Rebuild contracts from the current checkout
before running them. Use a separate checkout if you need to preserve the bindings
for the recorded Devnet deployment. From the repository root:

```sh
export GROUNDHOG_CLI=/absolute/path/to/groundhog
export GROUNDHOG_DEVNODE_BINARY=/absolute/path/to/hog-devnode
npm run generate:contracts --workspace apps/counter
npm run generate:contracts --workspace apps/token-launchpad
npm run generate:contracts --workspace apps/swap
npm run build --workspace apps/counter
npm --prefix apps/wallet-extension ci
npm run test:batching
npm run test:wallet
WALLET_ACCEPTANCE_LEGACY=1 npm run test:wallet
npm run test:seed
npm run test:counter
```

The CLI and devnode must agree on the runtime-manifest schema, including
`endpoints.schedulerGateway` when required by the CLI. A protocol override cannot
repair a schema mismatch. `GROUNDHOG_E2E_HOGD_PROTOCOL` selects an explicitly
compatible protocol build. `WALLET_ACCEPTANCE_ARTIFACT_ROOT` and
`SEED_TEST_ARTIFACT_ROOT` override the respective artifact roots. Use
`BATCH_TEST_ARTIFACT_ROOT` for the batching probe.

Live tests create separate node state, app environments, databases, and browser
profiles under the system temporary directory. They print their evidence paths.
The wallet runner removes temporary runtime state after verified cleanup; the
seed runner retains its isolated state for diagnosis. Neither replaces the
developer's app environments. Add `-- --devnet` to `test:wallet` only to request
the optional external identity/airdrop check; its result is reported separately.
Set `SEED_TEST_DEFAULT_OWNER=1` to check tool-account ownership instead of the
seed test's explicit recipient.

CI checks Rust contracts and frontend types, tests, builds, and browser fixtures.
Run the live application checks above locally.

Fixture tests do not prove live transaction execution. The live journey checks
completed-state reloads; it does not cover full browser restart with an unresolved
transaction or remote deployment. Wallet unit tests run independently through
`npm --prefix apps/wallet-extension test`.

## Prerequisites

- Rust (the pinned toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) is
  picked up automatically by rustup, including the `riscv32im-unknown-none-elf`
  target).
- The `groundhog` CLI, **version 0.19.0 or newer** (it must match the SDK the
  contracts build against):

  ```sh
  export CARGO_REGISTRIES_GROUNDHOG_INDEX="sparse+https://crates.thruput.network/api/v1/crates/"
  cargo install --locked --registry groundhog groundhog-cli
  ```

  (`cargo install` is global, so it does not see this repo's
  `.cargo/config.toml`; the environment variable supplies the registry index.)
  Individual applications may require a newer release than the contracts do;
  each app's README states its own minimum.

- Access to the `groundhog` crate registry. The registry index is configured in [`.cargo/config.toml`](.cargo/config.toml); credentials come from your cargo credential provider (e.g. `CARGO_REGISTRIES_GROUNDHOG_TOKEN`).
- `jq`, used by [`scripts/build-guest.sh`](scripts/build-guest.sh).
- For RPC-based tests, `groundhog-cli` must be able to find a "devnode" binary
  from the *same client release*.
  [`scripts/integration-tests.sh`](scripts/integration-tests.sh) takes the
  `hog-devnode` sitting beside the CLI on `PATH`, which is the matching one
  when both come from a client bundle, and checks the two releases agree before
  starting anything. `GROUNDHOG_DEVNODE_BINARY` overrides the choice.

## Building

Build a contract to a deployable guest binary (also generates the contract spec):

```sh
groundhog build -p fibonacci
```

Artifacts land in `target/groundhog/` as `<crate>.rv32a` and `<crate>.spec.xdr`.

## Testing

Tests come in three main kinds, distinguished by how the contract under test is executed.
(The contract crates set `test = false` on their `[lib]`, so all of their tests live in
`tests/` directories rather than in `src/`.)

| Kind | Command | Execution |
|------|---------|-----------|
| **native** | `cargo test -p <crate>` | Contract compiled natively and run against the SDK's mock environment (the `dev` feature). Fast; panics unwind, so error paths are catchable. |
| **rv32** | `groundhog test -p <crate>` | Contract compiled to RV32 and run by the mock executor — the same path as on-chain, where a fault is a real abort. Marked `#[ignore]` so plain `cargo test` skips it. |
| **rpc** | `groundhog test --integration -p <crate>` | Real transactions signed and submitted over JSON-RPC to a local devnode. |

### What is valid to run on each contract

| Contract | native | rv32 | rpc |
|-------|:------:|:----:|:---:|
| [`fibonacci`](contracts/fibonacci/) | ✅ | — | — |
| [`counter`](contracts/counter/) | ✅ | ✅ | ✅ |
| [`cross-call`](contracts/cross-call/) | ✅ | — | — |
| [`events`](contracts/events/) | ✅ | — | — |
| [`error-handling-callee`](contracts/error-handling-callee/) | ✅ | — | — |
| [`error-handling-caller`](contracts/error-handling-caller/) | ✅ | — | — |
| [`multi-throws`](contracts/multi-throws/) | ✅ | — | — |
| [`multi-impl-if`](interfaces/multi-impl-if/) | — | — | — |
| [`multi-impl`](contracts/multi-impl/) | ✅ | — | — |
| [`mixed-impl`](contracts/mixed-impl/) | ✅ | — | — |
| [`cross-trait-throws`](contracts/cross-trait-throws/) | ✅ | — | — |
| [`erc20`](contracts/erc20/) | ✅ | ✅ | ✅ |
| [`permit-wallet`](contracts/permit-wallet/) | ✅ | — | — |
| [`permit-relayer`](contracts/permit-relayer/) | — | — | — |
| [`sep41-token`](contracts/sep41-token/) | ✅ | ✅ | — |
| [`sep41-token-if`](interfaces/sep41-token-if/) | — | — | — |
| [`standard-token`](contracts/standard-token/) | ✅ | — | — |
| [`standard-token-factory`](contracts/standard-token-factory/) | ✅ | — | — |
| [`standard-token-factory-if`](interfaces/standard-token-factory-if/) | ✅ | — | — |
| [`swap-handler`](contracts/swap-handler/) | — | — | — |
| [`swap-driver`](contracts/swap-driver/) | ✅ | — | — |
| [`swap-router`](contracts/swap-router/) | ✅ | — | — |
| [`swap-factory`](contracts/swap-factory/) | ✅ | — | — |
| [`calldata`](sim-fixtures/calldata/) | ✅ | — | — |
| [`nnint-stress`](sim-fixtures/nnint-stress/) | ✅ | — | — |
| [`caller-counter`](sim-fixtures/caller-counter/) | — | — | — |

A `—` means the contract has no tests of that kind, or its behaviour is already
covered by the tests of the contracts that depend on it.

### Special cases

Beyond the tests in the table, there are two specially-handled kinds of test:

- **Guest tests.** `swap-driver`, `swap-router` and `swap-factory` have a `guest_test` feature
  that swaps their natively-linked collaborator contracts for built guest
  binaries — run them with `cargo test -p <crate> -F guest_test`, which is what
  [`scripts/swap-test-guest.sh`](scripts/swap-test-guest.sh) does.
- **Testkit simulation.**
  [`swap-router/tests/testkit_sim.rs`](contracts/swap-router/tests/testkit_sim.rs)
  drives the swap contracts on a live "devnode" via `groundhog-testkit`. It is
  `#[ignore]`d and needs a devnode binary; run it with
  [`scripts/swap-sim.sh`](scripts/swap-sim.sh).
  [`permit-wallet/tests/testkit_permit.rs`](contracts/permit-wallet/tests/testkit_permit.rs)
  does the same for the permit flow: the test signs a permit off-chain with
  a key the chain never sees, relays it through `permit-relayer`, draws on
  the allowance, and checks that a replay is refused. Run it with
  [`scripts/permit-live.sh`](scripts/permit-live.sh). The native version of
  the same flow, `permit-wallet/tests/permit.rs`, runs under plain
  `cargo test` and also covers `transfer_from_signed` and key rotation.
  [`speedex/tests/testkit_gas.rs`](contracts/speedex/tests/testkit_gas.rs)
  measures what the batch exchange's clearing costs on a devnode, by batch
  size and tâtonnement round cap; with the native execution-quality
  benchmark in `speedex/tests/quality.rs`, it is what
  [`scripts/speedex-bench.sh`](scripts/speedex-bench.sh) runs and graphs.

### Non-contract crates

The crates under [`helpers/`](helpers/), [`engines/`](engines/) and
[`interfaces/`](interfaces/) are library code rather than contracts, so they
have only native tests -- and [`swap-if`](interfaces/swap-if/), which is
declarations alone, has none.
[`swap-pair`](engines/swap-pair/) is the pair implementation the swap handler
runs in its own invocation, rather than a contract of its own.
[`batch-driver`](helpers/batch-driver/) is the reusable core of the
request-batching driver pattern.  It builds on
[`unique-ids`](helpers/unique-ids/), which mints ids distinct across
everything a contract accepts and stands on its own.

### Running tests

`cargo test --all` runs every **native** test in the workspace and skips the rest (rv32 tests
are `#[ignore]`d; guest tests need a feature flag; rpc tests are `test = false`):

```sh
cargo test --all
```

The other kinds need guest artifacts, so build them first:

```sh
./scripts/build-guest.sh
./scripts/swap-test-guest.sh     # guest tests for swap-driver, swap-router and swap-factory
./scripts/integration-tests.sh   # rpc tests
```

[`scripts/check-contracts.sh`](scripts/check-contracts.sh) runs native contract
tests, builds the guest binaries, runs the guest tests and integration
tests, and finishes with clippy and rustfmt. Live Swap and permit simulations
remain separate commands listed above; application checks are listed under
[Application checks](#application-checks).

## Repository structure

- `apps/`: applications, each with its own README and setup scripts.
- `contracts/`, `engines/`, `helpers/`, `interfaces/`: contracts and supporting Rust code.
- `scripts/`: contract build/check commands and shared `seed/` tooling.
- `tests/browser/`, `tests/e2e/`: browser fixtures and cross-app live tests.
- `tests/token-factory-ts/`: TypeScript contract tests.
- `docs/specs/`, `docs/superpowers/`: design specifications and AI-assisted development records.

## License

[Apache-2.0](LICENSE)
