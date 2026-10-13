# Multi-throws: more than one error type

Learn to declare multiple exception types and classify outcomes with
`match_exn!`. This example also distinguishes declared, undeclared, forwarded,
and library exceptions from faults.

## Run

Complete the [Rust setup](../../docs/getting-started.md#1-rust-and-registry-access)
and the [error-handling examples](../error-handling-caller/README.md). From the root:

```sh
cargo test -p multi-throws --locked
```

Expected: **10 tests pass**. Deliberate exception and panic diagnostics are normal.
No node is needed.

## Read

1. [Contract and exception declarations](src/lib.rs).
2. [Tests](tests/test.rs), including outcome classification and forwarding.

## Try a change

Follow one declared exception from the throwing method through the forwarding
method and its test. Add a test assertion that checks the decoded exception
after forwarding rather than only checking that a call failed.

Next: [Multi-impl](../multi-impl/README.md) for separate contract interfaces.
