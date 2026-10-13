# Error-handling callee: produce different outcomes

This small contract is the target for the error-handling caller. It can succeed,
throw an exception, deliberately panic, or spend work in a loop. These let the
caller distinguish error categories.

## Run

Complete the [Rust setup](../../docs/getting-started.md#1-rust-and-registry-access).
From the repo root, with no node:

```sh
cargo test -p error-handling-callee --locked
```

Expected: **4 tests pass**. Deliberate panic/exception diagnostics are expected
in the output; they are the behavior under test.

## Read

1. [Contract](src/lib.rs): each method produces one outcome.
2. [Tests](tests/test.rs): assertions for those outcomes.

## Try a change

Change the successful test input and its expected result. Compare it with the
test that calls the deliberately failing method.

Next: [Error-handling caller](../error-handling-caller/README.md) shows how a
different contract handles these outcomes.
