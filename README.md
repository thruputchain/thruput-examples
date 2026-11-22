# Thruput examples

Learn Thruput with small Rust contracts and TypeScript scripts, then read
complete applications. Start with one example. You do not need to build or run
the whole repository.

To start your own project, use `thruput new --template counter` for a contract,
or `thruput new --template counter-app` for a contract with a small web app.
The [developer docs](https://www.thruput.network/docs/start/getting-started/)
explain the platform.

## Start here

| I want to…                 | Start with                                                                       | What I need                                     |
| -------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| Write a contract           | [Counter](contracts/counter/README.md)                                           | Rust; no running node                           |
| Use the TypeScript SDK     | [TypeScript examples](examples/typescript/README.md)                             | Node.js and a local node                        |
| Consume hosted blocks      | [Firehose consumer](examples/typescript/README.md#8-consume-the-hosted-firehose) | Node.js; no local node                          |
| Build a wallet app         | [Voting app](apps/voting/README.md)                                              | The app toolchain and [Thruput Freighter][wallet] |
| See all apps running       | [Apps](apps/README.md)                                                           | The app toolchain                               |

[wallet]: https://www.thruput.network/docs/tools/wallet-extension/

## Your first contract test

After you install Rust with rustup, run from the repository root:

```sh
cargo test -p counter --locked --test test
```

Expected: **3 tests pass**. You need no npm install, wallet, or node. Read
[the contract](contracts/counter/src/implementation.rs) and
[the test](contracts/counter/tests/test.rs), then follow the exercise in the
[Counter README](contracts/counter/README.md).

## Learning path

1. **[Counter contract](contracts/counter/README.md):** storage, an event, and a
   declared error, with native tests.
2. **[TypeScript examples](examples/typescript/README.md):** read the chain,
   transfer tokens, deploy Counter, read events, and submit a batch.
3. **Contract concepts:** [Fibonacci](contracts/fibonacci/README.md),
   [Events](contracts/events/README.md), [Cross-call](contracts/cross-call/README.md),
   [error handling](contracts/error-handling-caller/README.md), and
   [interfaces](contracts/multi-impl/README.md). The table below lists them all.
4. **[Voting app](apps/voting/README.md):** the first wallet app. A browser
   wallet signs each transaction, and the app recovers it after a reload.
5. **[Airdrop app](apps/airdrop/README.md):** claim tokens once per wallet.
6. **[Launchpad app](apps/token-launchpad/README.md):** create tokens through a
   factory, and index its events into a database.
7. **[Swap app](apps/swap/README.md):** queued swap requests, cranking, and
   liquidity.

## Contract examples

Each README has a test command, the expected result, and an exercise.

| Example                                                                                                                    | What you learn                                      |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [Counter](contracts/counter/README.md)                                                                                     | Store and update a non-negative counter             |
| [Fibonacci](contracts/fibonacci/README.md)                                                                                 | A stateless method, a declared error, and an event  |
| [Events](contracts/events/README.md)                                                                                       | Event payloads and indexed topics                   |
| [Cross-call](contracts/cross-call/README.md)                                                                               | Call another contract through its generated client  |
| [Error-handling callee](contracts/error-handling-callee/README.md) and [caller](contracts/error-handling-caller/README.md) | Tell declared errors, faults, and failed calls apart |
| [Multi-throws](contracts/multi-throws/README.md)                                                                           | Handle more than one declared error type            |
| [Multi-impl](contracts/multi-impl/README.md)                                                                               | Implement two interface traits at one address       |
| [Mixed-impl](contracts/mixed-impl/README.md)                                                                               | Combine inherent methods and a trait                |
| [Oracle consumer](contracts/oracle-consumer/README.md)                                                                     | Read a published price and check its freshness      |
| [Counter live test](contracts/counter-live/README.md)                                                                      | Deploy and call Counter on a local node from Rust   |

### Advanced contracts

These combine several concepts. Read a small example first.

| Example                                                                                      | What you learn                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [Cross-trait throws](contracts/cross-trait-throws/README.md)                                 | Catch errors across interface boundaries                        |
| [Voting](contracts/voting/README.md)                                                         | Admin permissions, a poll lifecycle, and mergeable vote totals  |
| [Airdrop](contracts/airdrop/README.md)                                                       | Atomic token claims with optional address eligibility           |
| [Waitlist](contracts/waitlist/README.md)                                                     | A fee steered by a backlog, shared by concurrent callers        |
| [ERC20](contracts/erc20/README.md)                                                           | Token balances, allowances, metadata, and permits               |
| [Standard token](contracts/standard-token/README.md) and [factory](contracts/standard-token-factory/README.md) | Tokens created by a factory, used by Launchpad |
| [Swap contracts](contracts/swap-router/README.md)                                            | Pools, routing, queued requests, and liquidity                  |
| [Permit wallet](contracts/permit-wallet/README.md) and [relayer](contracts/permit-relayer/README.md) | Off-chain authorization                                  |
| [Stellar account](contracts/stellar-account/README.md)                                       | Weighted Ed25519 and ML-DSA-65 signers and thresholds           |
| [Speedex](contracts/speedex/README.md)                                                       | Multi-asset batch exchange and clearing (research)              |

## Applications

Five teaching apps show complete flows: Counter, Voting, Airdrop, Token
Launchpad, and Swap. They are not production services. Start with
[apps/README.md](apps/README.md).

## Setup

Run commands from the repository root. Use Node.js **22.13+**, npm, and
[rustup](https://rustup.rs/). The committed `rust-toolchain.toml` selects Rust.
All Rust crates and `@thruputchain/*` packages are public; you need no tokens.

```sh
rustup show
cargo install --locked --version '>=0.47.0' thruput
thruput toolchain install
npm ci
```

Use CLI **0.47.0 or newer**, and let it select its managed runtime. Native
contract tests need only Rust.

For the TypeScript examples and the apps, run a local node in a separate
terminal, and leave it running:

```sh
thruput node --port 9545 --json
```

Then run `npm run example:chain-tip` for a first read.

## More

- [scripts/README.md](scripts/README.md): repository layout, tools, and checks.
- [CONTRIBUTING.md](CONTRIBUTING.md): checks and dependency updates.
- [AGENTS.md](AGENTS.md): instructions for coding agents.

## License

[Apache-2.0](LICENSE), except the swap contract suite (`swap-*` contracts,
`engines/swap-pair`, and `interfaces/swap-if`). It is a port of
[UniswapV2](https://github.com/Uniswap/v2-core), so it is
[GPL-3.0-or-later](LICENSE-GPL-3.0). Each crate's `Cargo.toml` names its license.
