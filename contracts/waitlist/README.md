# Waitlist: a fee steered by the backlog

A waitlist whose entry fee is priced like an EIP-1559 base fee, steered by how
many are waiting. A new list is free. In each block that starts with more than
a target number waiting, the fee rises by up to an eighth; in each that starts
with fewer, it falls by up to an eighth, back toward zero; at the target, it
holds. So the target is not a line below which joining is free: a fee that has
built up stays until the backlog has spent some blocks below the target. A
backlog that nobody serves keeps raising the fee, block after block, up to a
maximum set when the list starts; serving it brings the fee back down, and
anyone may serve. The fee comes
from [`fee-market`](../../helpers/fee-market/src/lib.rs), a storage type any
contract can embed, given a load of its own to steer by.

Read [Counter](../counter/README.md) first.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, without a node or npm:

```sh
cargo test -p waitlist --locked --test test
```

Expected: **5 tests pass**. A short list is free to join. A backlog above the
target makes the next block's fee 1: a caller with no allowance is refused, and
one with an allowance pays exactly the fee. A backlog nobody serves keeps
raising the fee with no one joining, until it reaches the maximum; serving it
brings the fee back to zero. The fee cannot be started twice. The expected exceptions can appear in the test
output; the final result is what determines success.

## Read

1. [Implementation](src/implementation.rs): a `Balance` for the backlog and a
   `Node<FeeMarket>` for the fee, side by side in the contract's storage. `join`
   reads the backlog *before* adding itself, so every join in a block passes
   the same load; `serve` updates the fee too, because it changes the load.
2. [`fee-market`](../../helpers/fee-market/src/lib.rs): why every caller in a
   block computes the same fee, and records it without conflicting with the
   others.
3. [Native tests](tests/test.rs): blocks advance with `advance_block`, and a
   write such as an allowance is visible from the next block.

`join` collects the fee in native tokens, on an allowance the caller grants this
contract, and keeps it. A zero fee is not collected, so a short list needs no
allowance at all.

## Try a change

In the tests, raise `MAX_FEE` from 3 to 10, and rerun. The lingering-backlog
test now fails: the fee no longer stops at the maximum but reaches 7, one unit
for each of the seven blocks the backlog sat there. Expect 7 instead.

To steer a fee in your own contract, add a `Node<FeeMarket>` to its storage,
`initialize` it once with a target and a maximum, and call `update` with your
load -- the
same value for every transaction in a block -- wherever you charge the fee and
wherever the load changes. See the
[`fee-market`](../../helpers/fee-market/src/lib.rs) crate docs.
