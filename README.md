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
   [interfaces](contracts/multi-impl/README.md). [contracts/README.md](contracts/README.md)
   lists them all.
4. **[Voting app](apps/voting/README.md):** the first wallet app. A browser
   wallet signs each transaction, and the app recovers it after a reload.
5. **[Airdrop app](apps/airdrop/README.md):** claim tokens once per wallet.
6. **[Launchpad app](apps/token-launchpad/README.md):** create tokens through a
   factory, and index its events into a database.
7. **[Swap app](apps/swap/README.md):** queued swap requests, cranking, and
   liquidity.

## Contract examples

[contracts/README.md](contracts/README.md) lists every contract in learning
order, in three tiers:

- **Basics:** Counter, Fibonacci, Events, Cross-call, error handling, and
  interfaces.
- **Intermediate:** ERC20, Voting, Airdrop, and an oracle consumer.
- **Advanced projects:** groups of crates that work together: Token factory,
  Swap, Permit, Stellar account, Waitlist, Stream, and Speedex. Swap and Speedex
  include benchmarks.

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
cargo install --locked --version '>=0.48.0' thruput
thruput toolchain install
npm ci
```

Use CLI **0.48.0 or newer**, and let it select its managed runtime. Native
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

[Apache-2.0](LICENSE), except the UniswapV2 port in
[`contracts/swap/`](contracts/swap/README.md): `interface`, `pair`, `handler`,
`driver`, `router`, `factory`, and `bench`. It is a port of
[UniswapV2](https://github.com/Uniswap/v2-core), so it is
[GPL-3.0-or-later](LICENSE-GPL-3.0). Each crate's `Cargo.toml` names its license.
