# groundhog-examples

Example smart contracts for the [Groundhog SDK](https://github.com/groundhogchain/sdk_rs). Each
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
| [`multi-impl-traits`](contracts/multi-impl-traits/) | Defining contract interfaces as traits in a standalone crate |
| [`multi-impl`](contracts/multi-impl/) | One contract implementing multiple traits from a separate crate |
| [`mixed-impl`](contracts/mixed-impl/) | One contract exposing both an inherent (`notrait`) `#[contract]` impl and a trait `#[contract]` impl |
| [`cross-trait-throws`](contracts/cross-trait-throws/) | One contract implementing two traits with different `throws` types; a client on one catching the peer trait's error with `match_exn!` |
| [`erc20`](contracts/erc20/) | A fuller, realistic contract: an ERC20 token implementing an external interface trait, with `Map`/`NNInt` storage and an optional `metadata` feature |
| [`standard-token*`](contracts/standard-token-factory/) | A fixed standard-token implementation and factory with a [local launchpad](apps/token-launchpad/README.md) |
| [`swap-*`](docs/README-swap.md) | A Uniswap V2-style pair with router, request queue, handler, lifecycle events, and a [local frontend](apps/swap/README.md) |

### Simulation fixtures

The crates under [`sim-fixtures/`](sim-fixtures/) are not pedagogical examples — they are contracts with specific workload shapes used as fixtures for testing the transaction simulator:

| Crate | Workload |
|-------|----------|
| [`caller-counter`](sim-fixtures/caller-counter/) | Per-caller counter exercising read-after-write storage patterns |
| [`calldata`](sim-fixtures/calldata/) | Calldata-heavy entry points |
| [`nnint-stress`](sim-fixtures/nnint-stress/) | NNInt-heavy writes with refund capping |

## Prerequisites

- Rust (the pinned toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) is
  picked up automatically by rustup, including the `riscv32im-unknown-none-elf`
  target).
- The `groundhog` CLI, **version 0.14.0 or newer** (it must match the SDK the
  contracts build against):

  ```sh
  export CARGO_REGISTRIES_GROUNDHOG_INDEX="sparse+https://groundhog.dev/crates/api/v1/crates/"
  cargo install --locked --registry groundhog groundhog-cli
  ```

  (`cargo install` is global, so it does not see this repo's
  `.cargo/config.toml`; the environment variable supplies the registry index.)
  Individual applications may require an exact CLI release. The token launchpad requires 0.10.4.

- Access to the `groundhog` crate registry. The registry index is configured in [`.cargo/config.toml`](.cargo/config.toml); credentials come from your cargo credential provider (e.g. `CARGO_REGISTRIES_GROUNDHOG_TOKEN`). Get a token at [groundhog.dev/crates](https://groundhog.dev/crates).
- `jq`, used by [`scripts/build-guest.sh`](scripts/build-guest.sh).
- For RPC-based tests, `groundhog-cli` must be able to find a "devnode" binary, for example via `GROUNDHOG_DEVNODE_BINARY`.

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
| [`multi-impl-traits`](contracts/multi-impl-traits/) | — | — | — |
| [`multi-impl`](contracts/multi-impl/) | ✅ | — | — |
| [`mixed-impl`](contracts/mixed-impl/) | ✅ | — | — |
| [`cross-trait-throws`](contracts/cross-trait-throws/) | ✅ | — | — |
| [`erc20`](contracts/erc20/) | ✅ | ✅ | ✅ |
| [`swap-handler`](contracts/swap-handler/) | — | — | — |
| [`swap-driver`](contracts/swap-driver/) | ✅ | — | — |
| [`swap-router`](contracts/swap-router/) | ✅ | — | — |
| [`swap-factory`](contracts/swap-factory/) | ✅ | — | — |
| [`batch-driver`](helpers/batch-driver/) | ✅ | — | — |
| [`swap-pair`](engines/swap-pair/) | ✅ | — | — |
| [`calldata`](sim-fixtures/calldata/) | ✅ | — | — |
| [`nnint-stress`](sim-fixtures/nnint-stress/) | ✅ | — | — |
| [`caller-counter`](sim-fixtures/caller-counter/) | — | — | — |

A `—` means the contract has no tests of that kind, or its behaviour is already
covered by the tests of the contracts that depend on it.

The crates under [`helpers/`](helpers/), [`engines/`](engines/) and
[`interfaces/`](interfaces/) are library code rather than contracts, so they
have only native tests -- and [`swap-if`](interfaces/swap-if/), which is
declarations alone, has none.
[`swap-pair`](engines/swap-pair/) is the pair implementation the swap handler
runs in its own invocation, rather than a contract of its own.
[`batch-driver`](helpers/batch-driver/) is the reusable core of the
request-batching driver pattern.

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

### Running them

`cargo test --all` runs every **native** test in the workspace and skips the rest (rv32 tests
are `#[ignore]`d; guest tests need a feature flag; rpc tests are `test = false`):

```sh
cargo test --all
```

The other kinds need guest artifacts, so build them first:

```sh
./scripts/build-guest.sh
./scripts/swap-test-guest.sh     # guest tests for swap-driver and swap-router
./scripts/integration-tests.sh   # rpc tests
```

[`scripts/check-all.sh`](scripts/check-all.sh) covers everything: it runs the
native tests, builds the guest binaries, runs the guest tests and integration
tests, and finishes with clippy and rustfmt.

## License

[Apache-2.0](LICENSE)
