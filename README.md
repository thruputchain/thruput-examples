# groundhog-examples

Example smart contracts for the [Groundhog SDK](https://github.com/groundhogchain/sdk_rs). Each crate in this Cargo workspace demonstrates a specific SDK feature, from a minimal stateless contract up to cross-contract calls, error handling, and event emission.

## Examples

A suggested reading order for newcomers is `fibonacci` → `cross-call` → `events`, then the error-handling pair.

| Crate | Demonstrates |
|-------|--------------|
| [`fibonacci`](fibonacci/) | Minimal stateless contract: one method, one error type, one event |
| [`cross-call`](cross-call/) | Cross-contract call patterns via a generated client (`call`, `try_*`, error forwarding); calls `fibonacci` |
| [`events`](events/) | `#[derive(Event)]` with the full range of topic and payload patterns: payload-only, address topics, hashed topics, topics-only, multi-emit |
| [`error-handling-callee`](error-handling-callee/) | Producing error conditions (declared throws, undeclared errors, panics/faults) for callers to handle |
| [`error-handling-caller`](error-handling-caller/) | Catching, wrapping, and forwarding errors from a callee contract |
| [`multi-throws`](multi-throws/) | Declaring multiple error types with `throws(A, B)` |
| [`multi-impl-traits`](multi-impl-traits/) | Defining contract interfaces as traits in a standalone crate |
| [`multi-impl`](multi-impl/) | One contract implementing multiple traits from a separate crate |

### Simulation fixtures

The crates under [`sim-fixtures/`](sim-fixtures/) are not pedagogical examples — they are contracts with specific workload shapes used as fixtures for testing the transaction simulator:

| Crate | Workload |
|-------|----------|
| [`caller-counter`](sim-fixtures/caller-counter/) | Per-caller counter exercising read-after-write storage patterns |
| [`calldata`](sim-fixtures/calldata/) | Calldata-heavy entry points |
| [`nnint-stress`](sim-fixtures/nnint-stress/) | NNInt-heavy writes with refund capping |

## Prerequisites

- Rust (the pinned toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) is picked up automatically by rustup, including the `wasm32-unknown-unknown` target)
- The `groundhog` CLI, **version 0.5.5 or newer** — older versions cannot parse the event spec fragments emitted by SDK 0.15.0+ and fail with `unexpected discriminator value: 4`:

  ```sh
  cargo install --registry groundhog groundhog-cli
  ```

- Access to the `groundhog` crate registry. The registry index is configured in [`.cargo/config.toml`](.cargo/config.toml); credentials come from your cargo credential provider (e.g. `CARGO_REGISTRIES_GROUNDHOG_TOKEN`).

## Building

Build a contract to deployable WASM (also generates the contract spec):

```sh
groundhog build -p fibonacci
```

Artifacts land in `target/groundhog/` as `<crate>.wasm` and `<crate>.spec.xdr`.

## Testing

Tests run natively against the SDK's mock environment (the `dev` feature):

```sh
cargo test --all
```

## Declaring events

As of SDK 0.15.0, events a contract emits must be declared on the `#[contract]` attribute with `emits(...)` for their definitions to be included in the contract spec:

```rust
#[derive(Event)]
pub struct FibComputed {
    pub input: u64,
    pub result: u64,
}

#[contract(throws = FibError, emits(FibComputed))]
impl Fibonacci {
    // ...
}
```

See the [`events`](events/) crate for topic patterns (`#[topic]` fields, address vs hashed topics) and [`fibonacci`](fibonacci/) for the minimal case.

## License

[Apache-2.0](LICENSE)
