# Multi-throws: more than one error type

Learn to declare more than one exception type on one interface, and to
classify every outcome with one `match_exn!`. It also shows how a forwarded
error keeps its type, and how to catch an SDK exception.

Faults are covered in the [error-handling examples](../error-handling-caller/README.md).
Errors that a *different* interface declared are covered in
[Cross-trait throws](../cross-trait-throws/README.md).

## Run

Complete the [setup](../../README.md#setup)
and the [error-handling examples](../error-handling-caller/README.md). From the root:

```sh
cargo test -p multi-throws --locked
```

Expected: **6 tests pass**. Deliberate exception diagnostics are normal.
No node is needed.

## Read

1. [Contract and exception declarations](src/lib.rs).
2. [Tests](tests/test.rs), including outcome classification and forwarding.

## Try a change

Follow one declared exception from the throwing method through the forwarding
method and its test. Add a test assertion that checks the decoded exception
after forwarding rather than only checking that a call failed.

Next: [Multi-impl](../multi-impl/README.md) for separate contract interfaces.
