# Thruput examples

Learn Thruput with small Rust contracts and TypeScript scripts, then explore
complete applications. Start with one example; you do not need to build or run
the whole repository.

## Start here

| I want to… | Start with | What I need |
| --- | --- | --- |
| Write a contract | [Counter](contracts/counter/README.md) | Rust and Cargo registry access; no running node |
| Use the TypeScript SDK | [Client examples](examples/typescript/README.md) | Node.js, npm package access, and a local node |
| Consume hosted blocks | [Firehose consumer](examples/typescript/README.md#7-consume-the-hosted-firehose) | Node.js and the repo npm install; no local node |
| Try an application | [Counter app](apps/counter/README.md) | Rust, Node.js, CLI, and a local node |
| Explore a full wallet app | [Token Launchpad](apps/token-launchpad/README.md), then [Swap](apps/swap/README.md) | The app toolchain and [Thruput Freighter](https://github.com/thruputchain/freighter) |

Follow [Setup](#setup) for registry access, toolchain installation, and the local
node. The [developer tutorials](https://docs.thruput.network/start/getting-started/)
explain the platform and creating your own project with `thruput new`.

### Your first contract test

After configuring Rust registry access, run from the repository root:

```sh
cargo test -p counter --locked --test test
```

Expected: **2 tests pass**. The first initializes the counter to 10, adds 5,
subtracts 3, and reads 12. The second checks that decrementing below zero fails.
No npm install, wallet, or node is needed for these native tests.

Read [the contract](contracts/counter/src/implementation.rs), then
[the test](contracts/counter/tests/test.rs). Change the increment from 5 to 7
and update the expected values. Run the same command again.

With the CLI installed, build the deployable contract:

```sh
thruput build -p counter
```

The artifact is `target/thruput/counter.rv32a`. Next, use the
[TypeScript examples](examples/typescript/README.md) to deploy it, call it,
read events, and submit a batch.

## App visual identity

Counter, Voting, Swap, and Token Launchpad use the Stellar Thruput identity and follow
the system's light or dark theme. Each app keeps its tokens in `src/styles.css`.
Inter Variable is used for headings, body text, and UI actions. Inconsolata
Variable is used for code, numbers, balances, and system labels. Both are
self-hosted through Fontsource.

The `signal` token stays yellow (`#FDDA24`) for filled actions. `primary` is a
theme-aware accent for readable links and focus indicators. Keep these roles
separate when adding controls.

The SVGs in each app's `public/brand/` and its favicon use the official Stellar
Logo Press Kit 2026 vector paths.

## Setup

Run commands from the repository root. Use Node.js **22.13+**, npm, and
[rustup](https://rustup.rs/). The checked-in `rust-toolchain.toml` selects Rust.

### Rust and CLI

The repo configures the private `thruput` Cargo registry. You need access and a
credential provider. Save your token at Cargo's prompt:

```sh
export CARGO_REGISTRIES_THRUPUT_CREDENTIAL_PROVIDER=cargo:token
cargo login --registry thruput
rustup show
cargo install --locked --registry thruput --version 0.37.0 thruput-cli
thruput toolchain install
```

CLI **0.37.0** manages runtime **0.1.31-rc.14** (native RPC wire 14). Native tests need Rust and registry
access but no CLI or node. For contract builds, add this local profile to
`thruput.toml` if it is not already configured:

```toml
default_profile = "local"
[profile.local]
network = "local"
```

### npm

The published `@thruputchain/*` packages use GitHub Packages. Add this to your
user `~/.npmrc`, then set `GITHUB_PACKAGES_TOKEN` to a PAT with `read:packages`
and access to the packages:

```ini
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Run `npm ci` at the root. This installs dependencies for all apps and client
examples. Keep credentials outside the repository.

### Local node

In a separate terminal, run `thruput node --port 9545 --json` and leave it running.
For client scripts, set `THRUPUT_RPC_URL=http://127.0.0.1:9545`. App setup also
needs `THRUPUT_CLI` (the CLI executable) and `THRUPUT_RUNTIME_MANIFEST` (the path
printed by that node). Use the new manifest after restarting the node.

Run `npm run example:chain-tip` for a first read. Continue with the
[client examples](examples/typescript/README.md) or an app README.
If authentication fails, check registry/package access. If the CLI rejects a
runtime manifest, use its matching managed runtime rather than a protocol override.

## Small contract examples

Each README includes a test command, expected result, and an exercise.
Suggested order: **Counter → Fibonacci → Events → Cross-call → error handling**.

| Example | What you learn |
| --- | --- |
| [Counter](contracts/counter/README.md) | Store and update a non-negative counter |
| [Voting](contracts/voting/README.md) | Admin permissions, poll lifecycle, and mergeable vote totals |
| [Fibonacci](contracts/fibonacci/README.md) | A stateless method, a declared error, and an event |
| [Events](contracts/events/README.md) | Event payloads and indexed topics |
| [Cross-call](contracts/cross-call/README.md) | Call another contract through its generated client |
| [Error-handling callee](contracts/error-handling-callee/README.md) and [caller](contracts/error-handling-caller/README.md) | Distinguish declared errors, faults, and failed calls |
| [Multi-throws](contracts/multi-throws/README.md) | Handle more than one declared error type |
| [Multi-impl](contracts/multi-impl/README.md) | Implement separate interface traits at one address |
| [Mixed-impl](contracts/mixed-impl/README.md) | Combine inherent methods and a trait implementation |
| [Cross-trait throws](contracts/cross-trait-throws/README.md) | Catch errors across interface boundaries |

## Larger reference examples

These combine several concepts. Read a small example first.

| Example | Purpose |
| --- | --- |
| [ERC20](contracts/erc20/README.md) | Token balances, allowances, metadata, and optional permits |
| [Permit wallet](contracts/permit-wallet/) and [relayer](contracts/permit-relayer/) | Off-chain authorization and auth-token composition; run with `scripts/permit-live.sh` |
| [Standard token](contracts/standard-token/) and [factory](contracts/standard-token-factory/) | Factory-created tokens, used by Launchpad |
| [Swap contracts](contracts/swap-router/README.md) | Pools, routing, queued requests, and liquidity |
| [Speedex](contracts/speedex/README.md) | Multi-asset batch exchange and clearing |
| [Stellar account](contracts/stellar-account/README.md) | Weighted Ed25519 and ML-DSA-65 signers and operation thresholds |

## Applications

| App | Purpose |
| --- | --- |
| [Counter](apps/counter/README.md) | Development-signed concurrent updates or wallet-approved button updates, with reload recovery |
| [Voting](apps/voting/README.md) | Create multi-question polls, vote once per question, and view live results on localnode |
| [Token Launchpad](apps/token-launchpad/README.md) | Create tokens with an external wallet and browse indexed launches |
| [Swap](apps/swap/README.md) | Create pools, swap tokens, and manage liquidity |

The Counter **contract** is introductory; the Counter **app** demonstrates
concurrency and transaction observation. Launchpad and Swap include registry
servers and transaction recovery, so they are full application references.

All apps share the root npm install. Each app has its own setup instructions.
Local setup creates fresh infrastructure. Seeding requires `SEED_RECIPIENT` and
creates new demo tokens and optional liquidity on every run, without saving
keys or recovery state. Use the same node and RPC endpoint in both apps and Freighter.

## Examples versus tools

| Location | Audience and purpose |
| --- | --- |
| `examples/typescript/` | Small scripts to read, run, and modify while learning the published SDK |
| `contracts/` | Rust contracts and their focused tests |
| `apps/*/scripts/` | Setup, binding generation, and seed entrypoints for that app |
| `scripts/seed/` | Shared app-seeding implementation; not an introductory SDK example |
| `scripts/` | Maintainer builds, checks, live scenarios, and benchmarks; see the [script index](scripts/README.md) |
| `interfaces/`, `engines/`, `helpers/` | Supporting Rust interfaces and implementations |
| `sim-fixtures/` | Workloads for simulator testing, not tutorials |
| `tests/browser/`, `tests/e2e/` | Browser fixtures and live acceptance tests |

## Development and verification

- [Setup](#setup): credentials, install, and node.
- [Script index and checks](scripts/README.md): tests, requirements, and side effects.
- [AGENTS.md](AGENTS.md): repository instructions for coding agents.

## License

[Apache-2.0](LICENSE)
