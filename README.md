# groundhog-examples

Example smart contracts for the [Groundhog SDK](https://github.com/groundhogchain/sdk_rs). Each crate in this Cargo workspace demonstrates a specific SDK feature, from a minimal stateless contract up to cross-contract calls, error handling, and event emission.

## Examples

A suggested reading order for newcomers is `fibonacci` → `cross-call` → `events`, then the error-handling pair.

| Crate | Demonstrates |
|-------|--------------|
| [`fibonacci`](contracts/fibonacci/) | Minimal stateless contract: one method, one error type, one event |
| [`cross-call`](contracts/cross-call/) | Cross-contract call patterns via a generated client (`call`, `try_*`, error forwarding); calls `fibonacci` |
| [`events`](contracts/events/) | `#[derive(Event)]` with the full range of topic and payload patterns: payload-only, address topics, hashed topics, topics-only, multi-emit |
| [`error-handling-callee`](contracts/error-handling-callee/) | Producing error conditions (declared throws, undeclared errors, panics/faults) for callers to handle |
| [`error-handling-caller`](contracts/error-handling-caller/) | Catching, wrapping, and forwarding errors from a callee contract |
| [`multi-throws`](contracts/multi-throws/) | Declaring multiple error types with `throws(A, B)` |
| [`multi-impl-traits`](contracts/multi-impl-traits/) | Defining contract interfaces as traits in a standalone crate |
| [`multi-impl`](contracts/multi-impl/) | One contract implementing multiple traits from a separate crate |
| [`erc20`](contracts/erc20/) | A fuller, realistic contract: an ERC20 token implementing an external interface trait, with `Map`/`NNInt` storage and an optional `metadata` feature |
| [`swap-*`](docs/README-swap.md) | A Uniswap V2-style pair with router, request queue, handler, lifecycle events, and a [local frontend](apps/swap/README.md) |

### Simulation fixtures

The crates under [`sim-fixtures/`](sim-fixtures/) are not pedagogical examples — they are contracts with specific workload shapes used as fixtures for testing the transaction simulator:

| Crate | Workload |
|-------|----------|
| [`caller-counter`](sim-fixtures/caller-counter/) | Per-caller counter exercising read-after-write storage patterns |
| [`calldata`](sim-fixtures/calldata/) | Calldata-heavy entry points |
| [`nnint-stress`](sim-fixtures/nnint-stress/) | NNInt-heavy writes with refund capping |

## Prerequisites

- Rust (the pinned toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) is picked up automatically by rustup, including the `wasm32-unknown-unknown` target)
- The `groundhog` CLI, **version 0.5.5 or newer**

  ```sh
  cargo install --registry groundhog groundhog-cli
  ```

- Access to the `groundhog` crate registry. The registry index is configured in [`.cargo/config.toml`](.cargo/config.toml); credentials come from your cargo credential provider (e.g. `CARGO_REGISTRIES_GROUNDHOG_TOKEN`).

## Building

Build a contract to a deployable guest binary (also generates the contract spec):

```sh
groundhog build -p fibonacci
```

Artifacts land in `target/groundhog/` as `<crate>.rv32a` and `<crate>.spec.xdr`.

## Testing

Tests run natively against the SDK's mock environment (the `dev` feature):

```sh
cargo test --all
```

## License

[Apache-2.0](LICENSE)
