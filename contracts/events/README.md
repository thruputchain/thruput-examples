# Events: payloads and topics

Learn to emit structured events and inspect them in a transaction result.
Payload fields carry data; topics support indexed filtering.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, with no node:

```sh
cargo test -p events --locked
```

Expected: **6 tests pass**, covering payloads, address topics, string/scalar
topics, topics-only events, multiple events, and distinct event signatures.

## Read

1. [Event definitions and methods](src/lib.rs).
2. [Tests](tests/test.rs), especially `test_tagged_action_with_hashed_category_and_scalar_code`.

Every event has a signature topic. Addresses are passed through as 32 bytes;
strings are hashed; integer topics use padded big-endian values. Use the tests
as the executable reference for the current encoding.

## Try a change

Change the tagged-action test's code from 7 to 8 and update the expected scalar
topic. Keep the category unchanged and check that its hashed topic stays equal.

Next: [Cross-call](../cross-call/README.md). For RPC event queries, see
[the client event example](../../examples/typescript/README.md#6-read-events).
