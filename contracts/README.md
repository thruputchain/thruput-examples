# Contract examples

Rust contracts, in learning order. Start with the basics; each example adds a
little to the one before. You do not need to build the whole workspace: run one
example's tests with `cargo test -p <crate> --locked`.

Each folder here is one of two kinds:

- **An example:** one crate, with a README that has a test command, the expected
  result, and an exercise.
- **A project:** a folder of related crates, with a README that gives them in
  reading order.

## Basics

| Example | What you learn |
| --- | --- |
| [Counter](counter/README.md) | Store and update a non-negative counter |
| [Fibonacci](fibonacci/README.md) | A stateless method, a declared error, and an event |
| [Events](events/README.md) | Event payloads and indexed topics |
| [Cross-call](cross-call/README.md) | Call another contract through its generated client |
| [Error-handling callee](error-handling-callee/README.md) and [caller](error-handling-caller/README.md) | Tell declared errors, faults, and failed calls apart |
| [Multi-throws](multi-throws/README.md) | Handle more than one declared error type |
| [Multi-impl](multi-impl/README.md) | Implement two interface traits at one address |
| [Mixed-impl](mixed-impl/README.md) | Combine inherent methods and a trait |
| [Counter live test](counter-live/README.md) | Deploy and call Counter on a local node from Rust |

## Intermediate

These combine several concepts. Read a basic example first.

| Example | What you learn |
| --- | --- |
| [Cross-trait throws](cross-trait-throws/README.md) | Catch errors across interface boundaries |
| [Oracle consumer](oracle-consumer/README.md) | Read a published price and check its freshness |
| [ERC20](erc20/README.md) | Token balances, allowances, metadata, and permits |
| [Voting](voting/README.md) | Admin permissions, a poll lifecycle, and mergeable vote totals |
| [Airdrop](airdrop/README.md) | Atomic token claims with optional address eligibility |
| [Fixed odds](fixed-odds/README.md) | A betting book whose solvency the runtime checks across a block's bets |

The [Voting](../apps/voting/README.md) and [Airdrop](../apps/airdrop/README.md)
apps run on these contracts.

## Advanced projects

Several crates that work together, to show what Thruput can do. Each project
README gives its crates in reading order.

| Project | What it shows | Used by |
| --- | --- | --- |
| [Token factory](token-factory/README.md) | Tokens created by a factory at predictable addresses | [Launchpad app](../apps/token-launchpad/README.md) |
| [Swap](swap/README.md) | A UniswapV2 port with queued requests, so a pool is not limited to one swap per block; trader-protecting batch orderings | [Swap app](../apps/swap/README.md); benchmarks |
| [Permit](permit/README.md) | Approve a token spend with an off-chain signature | |
| [Stellar account](stellar-account/README.md) | Weighted Ed25519 and ML-DSA-65 signers and thresholds | |
| [Waitlist](waitlist/README.md) | A fee steered by a backlog, shared by concurrent callers | |
| [Speedex](speedex/README.md) | Multi-asset batch exchange and clearing (research) | Benchmarks |

Swap and Speedex include benchmarks. They are in each project's `bench/` folder,
and the project README tells how to run them and read the results.
