# Budget: one budget, many spenders at once

A shared budget that many spenders draw on at the same time: services, bots, AI
agents, the session keys of a game. The owner funds the budget with a token and
grants each spender a limit, a bucket that holds up to a **burst** and refills
at a steady **rate**. A second, shared limit bounds what every spender together
can pay out. A spend takes its amount from both buckets and pays it.

What makes this a Thruput example is that no spend waits for another. Any number
of spends, from different spenders or from one spender in many sessions, land
in the same block, and the runtime admits them while they fit both buckets. The
spends that do not fit are turned away, and nothing they did is kept. On most
chains, a shared limit is a number every spend reads and rewrites, so spends
against it run one at a time. Here each bucket's contents are a
[`CapacityConstraint`](src/bucket.rs): a sum the runtime checks across a
block's transactions, which each spend only subtracts from.

Read [Counter](../counter/README.md) and [Waitlist](../waitlist/README.md) first.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, without a node or npm:

```sh
cargo test -p budget --locked --test test
```

Expected: **11 tests pass**. A spender spends its burst, then only what flows
back, and one transaction's spends see each other. Refills add up exactly,
however often they happen. A hundred spends land in one block, and committing
them in the opposite order changes nothing. The shared limit trims a block that
asks for too much, and one spender's own limit trims its parallel sessions. A
revoke lands in the same block as the spender's spends, in either order. A
spender bound to a payee can pay no one else. Changing limits never conflicts
with spends. Only the owner manages the budget, and bad arguments are refused.
Under the network's default storage prices, spends store nothing new. Expected
exceptions can appear in the output; the final result is what determines success.

With the CLI installed, `thruput test -p budget` builds the contract and runs it
in the RV32 guest: spends the shared limit trims, an exact refill at an
irregular moment, and a revoke in the same block as a spend.

## How a bucket works

From [the first test](tests/test.rs): Alice's limit is a burst of 100, refilled
at 60 a minute, so one unit a second.

| Block         | Alice spends | Result                                       | Alice can spend next |
| ------------- | ------------ | -------------------------------------------- | -------------------: |
| 1             | 70 and 30    | Both land: together they fit the 100         |                    1 |
| 1             | 1 more       | Turned away by the runtime: nothing left     |                    1 |
| 2             | 2            | Refused by the contract: only 1 has refilled |                    1 |
| 2             | 1            | Lands                                        |                    1 |
| An hour later | nothing      | The bucket refills to its burst, no further  |                  100 |

Spends in one block do not see each other. The contract checks each against the
buckets as of the block's start, which turns away a spend that could never fit
with a clear error. Whether a block's spends fit *together* is the runtime's
check: it admits them while their sum fits, and turns away the rest with
`BoundsExceeded`.

Refilling a bucket means changing its capacity, and every spend in a block
refills the bucket the same way, from the same state at the block's start. They
all set the same capacity and record the same time, and identical writes to a
key do not conflict. Only what each spend takes differs, and those subtractions
merge. Units flow in on a fixed grid of moments, `period / refill` apart, and a
refill credits the ones it has passed. So no fraction of a unit is lost or
credited twice, however often or rarely the bucket refills.

## Why it holds up

- **Spends never conflict with each other.** They share the shared bucket and
  the budget's token balance, and only subtract from both. The test puts a
  hundred spends from fifty spenders in one block.
- **The limits cannot be overrun.** However many spends land in one block, the
  runtime admits them only while they fit both buckets. A token bucket also
  bounds any stretch of time: in `T` seconds a spender can pay at most its
  burst plus `T` seconds of refill, rounded up to a whole unit. A daily limit,
  by contrast, can be spent twice in the minutes around midnight.
- **A busy spender cannot hold off its own revocation.** A revoke deletes the
  grant, which spends only read, so it never conflicts with them. If it deleted
  the bucket too, it would conflict with every spend in its block, and a
  spender with a stolen key could hold the revoke out of block after block, for
  as long as its limit let it spend a single unit in each. The same goes for changing a limit: the owner writes only the
  grant or the budget's configuration, never what spends write.
- **Spends store nothing new.** A grant creates its bucket, and the shared bucket
  exists from the start, so spends only rewrite them. A block of spends costs
  the budget no storage deposits; the test checks this under the network's
  default storage prices. `forget` deletes a revoked spender's bucket and
  returns its deposits.
- **No step can be clogged.** A spend does a constant amount of work: two
  buckets and one transfer. Nothing loops over spenders, and there is no
  settlement or reset step for anyone to hold up.
- **A stolen key can do only so much.** A spender's key can spend no faster than
  its limit allows, and a spender bound to a `payee` can pay no one else.

What it does not protect against:

- **The owner is trusted.** The owner can grant any limit, and `withdraw` is
  outside every limit. A budget meant to survive a stolen owner key needs a
  timelock or a second key on those.
- **Spends in the revoke's own block still count.** They read the grant as of
  the block's start. They cannot take more than the spender's bucket held.
- **The block producer sets the clock.** Refills follow the block's timepoint,
  so a producer that ran the clock fast would refill buckets early.
- **The shared limit is first come, first served.** When a block's spends ask
  for more than the shared bucket holds, the ones admitted first take it. Size
  the shared limit with that in mind, or give each spender its own budget.
- **The token is trusted.** The budget pays out whatever token the owner names.

## Use it

The owner deploys the contract, sends it native tokens for its storage, and
calls `initialize(token, limit)` in the same transaction. The caller is the
owner, and `limit` is the shared one. The owner then funds the budget by
transferring tokens to its address.

`grant(spender, limit, payee)` adds a spender with a full bucket, or replaces
an existing spender's limit and payee. `revoke(spender)` stops a spender, and
`forget(spender)`, in a later block, deletes its bucket. `set_limit(limit)`
changes the shared limit. A new limit applies from the bucket's next refill,
and a bucket keeps what it holds, up to the new burst.

A spender calls `spend(to, amount)`. `available(spender)` shows what it could
spend in the current block, not counting others' spends in that block.

## Read

1. [Bucket](src/bucket.rs): `refill` for the arithmetic, and `take` for the
   identical refill and the subtraction.
2. [Implementation](src/implementation.rs): `spend` takes from two buckets.
   `grant`, `revoke`, and `set_limit` write only what spends read.
3. [Native tests](tests/test.rs): `env.transaction().build()` executes several
   transactions before any commits, which is how a test puts them in one block.
   `conflicts` shows why a transaction was left out.
4. [RV32 test](tests/test_rv32.rs): the same in the guest.

## Try a change

In `revoke`, also delete the spender's bucket:

```rust
self.buckets.at_mut(spender).delete();
```

Rerun the tests. `a_revoke_never_waits_for_spends` fails: the revoke and Alice's
spend now write the same keys, so whichever commits second is turned away. A
spender that keeps its key busy could keep its revocation out of every block.
