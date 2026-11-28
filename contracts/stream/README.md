# Stream: pay by the second, with nothing to crank

Payment streams: a payer streams `rate` tokens a second to a payee, for as many
seconds as it chooses, and pays for all of it up front. The payee withdraws what
has streamed, whenever it likes. The payer can cancel at any time and get back what
has not streamed yet. Subscriptions, salaries and vesting work this way. So does
an agent renting a machine by the second: it opens an hour's stream, uses ten
minutes, cancels, and has paid for exactly ten minutes.

What makes this a Thruput example is how a payee's streams are kept: as sums
that streams only add to and take back from. When a stream ends is kept in a
[Fenwick tree](fenwick/src/lib.rs), indexed by second. As a result:

- **Nothing conflicts.** Opening and cancelling streams never conflict with each
  other, or with the payee's withdrawals. A crowd of streams to one payee lands
  in one block, and the payee is owed the same whatever order they committed in.
- **A payee's work does not grow.** Finding what a payee is owed reads at most 64
  tree nodes and four totals, however many streams pay it.
- **Nothing has to run.** A stream stops paying at its end by itself. Nobody has
  to stop it, and no keeper has to be paid to watch for it.

On a chain that runs transactions one at a time, streams are usually kept in one
of two ways. Each stream can be kept on its own, and the payee then withdraws from
each one, so its work grows with its streams. Or each account keeps one running
rate, which every start and stop rewrites. A running rate cannot tell when a
stream has run out, so streams are open-ended, and someone has to be paid to stop
one whose payer runs dry.

Read [Counter](../counter/README.md) and [Waitlist](../waitlist/README.md) first.

## Run

Complete the [setup](../../README.md#setup).
From the repo root, without a node or npm:

```sh
cargo test -p fenwick -p stream --locked
```

Expected: **21 tests pass**, and one RV32 test is skipped (see below).

The tree's 7 tests check that its prefix sums match a plain array's over many
blocks, and that 40 adds in one block commit together, in either order, with the
same result. They also check that a prefix sum sees only the block's start, that
taking back an amount twice is refused, which nodes an add creates, and that a
prefix sum larger than any node can hold is still read exactly.

The contract's 14 tests check the following:

- A stream pays by the second, and stops at its end.
- A cancel refunds what has not streamed.
- A hundred streams to one payee land in one block, and committing them in the
  opposite order changes nothing.
- Opens, cancels and a withdrawal share a block, in either order.
- A payee withdraws once a block, a stream is cancelled once, and an id opens
  once.
- Many blocks of random opens, cancels and withdrawals match a model that works
  out each stream on its own. When all of them end, every token has gone where
  it should, and the contract holds none.
- Under the network's default storage prices, bonded streams cost the contract
  nothing, and unbonded streams drain it.
- Bad calls are refused.

The expected exceptions can appear in the test output. The final result is what
determines success.

With the CLI installed, `thruput test -p stream` builds the contract and runs the
deepest paths in the RV32 guest. These are an open that creates 62 nodes, a
cancel that takes back 62, and a withdrawal at the last second the tree holds,
which reads all 64.

## How a payee is paid

From [a test](stream/tests/test.rs): three streams to Bob, opened in the same
block.

| Seconds in | Running              | Bob's rate | Bob is owed |
| ---------: | -------------------- | ---------: | ----------: |
|          1 | 3/s, 5/s, 7/s        |         15 |          15 |
|         10 | 5/s, 7/s (3/s ended) |         12 |         150 |
|         15 | 5/s, 7/s             |         12 |         210 |
|         20 | 7/s (5/s ended)      |          7 |         270 |
|         30 | none                 |          0 |         340 |

Bob's rate is a step function of time. Each stream raises it by its rate at its
start, and lowers it again at its end. What Bob has earned by second `t` is the
area under that function up to `t`. A step of height `r` at second `s` adds
`r * (t - s)` to it, so a set of steps comes down to two sums: of the heights, and
of each height times its second.

- **Starts are all in the past.** A stream starts in the block that opens it, so
  every start counts at any time the contract asks about. The contract keeps two
  plain totals: `rates`, the sum of the rates, and `starts`, the sum of each rate
  times its start.
- **Ends are in the future.** An end counts only once `t` has passed it. The
  contract keeps two Fenwick trees indexed by second. `ends` holds each rate at its
  end, and `end_weights` holds each rate times its end. A prefix sum up to `t`
  gives the ends that have passed.

What Bob has earned by `t` is then:

```text
rates * t - starts - (ends(t) * t - end_weights(t)) + settled
```

`settled` is what cancelled streams paid before they stopped. Count seconds from
when the streams opened. At second 15 in the table, `rates` is 15 and `starts`
is 0. Only the 3/s stream has ended, at second 10, so `ends(15)` is 3 and
`end_weights(15)` is 30. Bob has earned `15 * 15 - (3 * 15 - 30) = 210`.

A cancel books what the stream paid into `settled`, and takes the stream back out
of all four sums. What Bob can withdraw is what he has earned, less what he has
withdrawn.

## How the tree answers in 32 reads

A Fenwick tree keeps a node for each index. Each node holds the sum over a range
of indices that ends there. Its length is the lowest set bit of the node's number.
For eight indices:

| Node   |   1 |     2 |   3 |     4 |   5 |     6 |   7 |     8 |
| ------ | --: | ----: | --: | ----: | --: | ----: | --: | ----: |
| Covers |   0 | 0 - 1 |   2 | 0 - 3 |   4 | 4 - 5 |   6 | 0 - 7 |

An add at index 2 adds to nodes 3, 4 and 8, the nodes whose ranges cover it. To
find a prefix sum up to index 5, read nodes 6 (4 - 5) and 4 (0 - 3). Over the 2^32
seconds the contract's tree holds, each of those is at most 32 nodes, one a level.

An add writes its amount into those nodes and reads none of them. Each node is a
non-negative integer in storage, and two transactions' additions to one merge. So
adds commute: any number land in a block, at any indices, without conflicting.
The [crate docs](fenwick/src/lib.rs) cover this, and what a subtract may take.

## Why it holds up

| Concern | Design | Test |
| --- | --- | --- |
| A crowd paying one payee | An open only adds to the payee's sums, and a cancel only takes back what an earlier block added. Neither reads a sum | `a_crowd_streams_to_one_payee_in_one_block_in_any_order`, `opens_cancels_and_a_withdrawal_share_a_block` |
| Paying a withdrawal twice | `withdraw` writes the payee's withdrawn total with an exclusive lock. Two withdrawals in one block would read the same total and pay the same amount twice. A plain write would not stop them: identical writes to one key merge | `a_payee_withdraws_once_a_block` |
| Refunding a stream twice | `cancel` deletes the record with an exclusive lock. Two deletes of one key do not conflict | `a_stream_is_cancelled_once` |
| Tokens lost or left over | No rounding: rates are whole tokens a second, and times whole seconds. Each stream's deposit is exactly what its payee is paid plus what its payer gets back | `every_token_comes_out` |
| Storage griefing | A payer deposits `item_bond` native tokens for each item its stream creates: its record, the payee's four totals for a first stream, and each tree node its end is the first to reach (`missing_nodes`). Cancelling returns the record's bond. Nodes and totals stay, so their bonds do too | `bonded_streams_pay_for_their_own_storage`, `without_a_bond_streams_drain_the_reserve` |
| A withdrawal blocked by others | Only the payee's own withdrawal writes its withdrawn total, so nobody else can take the lock from it. A payee's first stream creates the total, so no later open has to write it | All of the above |
| Execution limits | An open reads and writes at most 32 nodes in each tree. A cancel writes at most 64. A withdrawal or `owed` reads at most 64. Nothing loops over streams, and there is no crank | `test_rv32.rs`, in the guest: an open creating 62 nodes **2.7M gas**, a cancel **0.22M**, a withdrawal reading 64 nodes **2.7M** (cap: 1,000M) |

Reading a node costs far more gas than adding to one. An open checks every node
on its path, to bond the ones it creates, so it costs about as much as a
withdrawal.

What it does not protect against:

- **Block producers set the clock.** A block's timepoint decides how much has
  streamed by then.
- **The token is trusted.** A token that takes a fee on transfer, or changes
  balances by itself, breaks the exact accounting.
- **A stream cannot be changed.** It cannot be topped up, extended or paused, only
  cancelled. Opening a new one is how to pay more.
- **Stored totals are 128-bit.** The largest, the sum of each rate times its end
  second, could overflow only after streams paying the payee more than 2^95 base
  units. Past that, new streams to that payee are refused. Reads sum the nodes in
  256 bits, so what a payee is owed can always be read and withdrawn.
- **The clock runs out.** The tree holds 2^32 - 1 seconds from `initialize`,
  about 136 years.
- **Streams are public.** Anyone can see who pays whom, and how much.

## Use it

The deployer deploys the contract and calls `initialize(terms)` in one
transaction. `terms.token` is the token every stream pays in. Before or during
that transaction, the deployer sends the contract's address the native tokens
that [`reserve_needed`](stream/src/implementation.rs) asks for. Set `item_bond`
to at least the network's cost of a stream's record: `baseDataItemCost` plus
`bytestringCostPerByte` times about 60 bytes, in the RPC's storage costs.

A payer grants the contract allowances on the token and, for bonds, on the native
token. It then calls `open(payee, id, rate, seconds)`. The payee calls
`withdraw()` whenever it likes. The payer calls `cancel(id)` to stop a stream, or
to clear away one that has ended and get its bond back. `owed`, `owed_at`, `rate`
and `flow` are views.

## Read

1. [`fenwick`](fenwick/src/lib.rs): the tree, and why its updates commute.
2. [Implementation](stream/src/implementation.rs): `Payee` for the sums and
   `earned` for the formula above. `open` adds a stream, `cancel` takes one back
   out, and `withdraw` takes its lock.
3. [Native tests](stream/tests/test.rs): `env.transaction().build()` executes
   several transactions before any commits, which is how a test puts them in one
   block. `Model` works out every stream on its own, the slow way, for the sums
   to agree with.
4. [Tree tests](fenwick/tests/fenwick.rs) and the
   [RV32 test](stream/tests/test_rv32.rs).

## Try a change

In `withdraw`, replace `self.payees.at_mut_exclusive(&payee)` with
`self.payees.at_mut(&payee)`, and rerun. `a_payee_withdraws_once_a_block` fails:
both withdrawals commit, and Bob is paid 600 instead of 300. The extra 300 comes
out of the tokens held for Carol's stream.

In `cancel`, replace `record.delete_exclusive()` with `record.delete()`, and
rerun. `a_stream_is_cancelled_once` fails: both cancels commit, and the payer is
refunded twice. Bob's totals have room to take the stream out twice, because
another payer's identical stream pays him too.

To see why ends need a tree, in `Payee::earned` set `ended` to zero, and rerun.
Streams never stop paying, and six tests fail.
