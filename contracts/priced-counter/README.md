# Priced counter: an entry fee that follows demand

A counter whose increments pay a fee, priced like an EIP-1559 base fee: free
while increments stay at or under a target per block, rising by up to an
eighth in each block that receives more, and falling back in each that
receives fewer. The fee comes from
[`fee-market`](../../helpers/fee-market/src/lib.rs), a storage type any
contract can embed to price its own entries.

Read [Counter](../counter/README.md) first.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, without a node or npm:

```sh
cargo test -p priced-counter --locked --test test
```

Expected: **3 tests pass**. The first increments as often as the target allows
in one block and pays nothing. The second fills a block past the target, then
finds the next block's fee is 1: a caller with no allowance is refused, and one
with an allowance pays exactly the fee. The third checks that the fee cannot be
started twice. The expected exceptions can appear in the test output; the final
result is what determines success.

## Read

1. [Implementation](src/implementation.rs): a `Balance` for the count and a
   `Node<FeeMarket>` for the fee, side by side in the contract's storage.
2. [`fee-market`](../../helpers/fee-market/src/lib.rs): how every increment in a
   block computes the same fee from the state at the block's start, and records
   it without conflicting with the others.
3. [Native tests](tests/test.rs): blocks advance with `advance_block`, and a
   write such as an allowance is visible from the next block.

`increment` collects the fee in native tokens, on an allowance the caller
grants this contract, and keeps it. A zero fee is not collected, so a quiet
counter needs no allowance at all.

## Try a change

In `a_busy_block_raises_the_fee`, add a second busy block before Alice pays:
increment `2 * TARGET` more times and advance again. The fee is now 2, so give
Alice an allowance of 2 and expect her balance to drop by 2.

To price entries in your own contract, add a `Node<FeeMarket>` to its storage,
`initialize` it once with a target, and call `enter` on each entry; see the
[`fee-market`](../../helpers/fee-market/src/lib.rs) crate docs.
