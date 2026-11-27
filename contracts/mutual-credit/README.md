# Mutual credit: money made of trust

A payment network with no token. Members extend credit to each other: Bob lets
Alice owe him up to 100. A payment travels along a chain of these credit lines.
Say Bob trusts Alice, and Carol trusts Bob. Then Alice can pay Carol 30: Alice
comes to owe Bob 30 more, and Bob comes to owe Carol 30 more. Bob, in the
middle, is owed what he owes, so his position does not move. Alice's position
falls by 30, and Carol's rises by 30. Nothing is issued and nothing is held. A
member's position is what it is owed less what it owes, and all the positions
add up to zero. Time banks, local exchange trading systems, and trade-credit
networks between businesses work this way.

What makes this a Thruput example is the hub. Every line keeps a **room**: how
much more the debtor may owe. Each room is a
[`CapacityConstraint`](src/implementation.rs). A payment does not read and
rewrite a balance. At each hop it takes from one room and gives to another, and
the runtime admits a block's payments while every room stays at or above zero.
So a member whom many trust, and who trusts many, can carry any number of
payments in one block. No block can push any line past its limit. On a chain
that runs one transaction at a time, every payment through a popular member
waits its turn. On one that runs transactions in parallel but locks what each
writes, they still queue for that member's balances. Here each payment is an
addition to the rooms on its route.

Read [Counter](../counter/README.md) first.

## Run

Complete the [setup](../../README.md#setup).
From the repo root, without a node or npm:

```sh
cargo test -p mutual-credit --locked --test test
```

Expected: **17 tests pass**:

- A payment ripples through a friend, whose position does not move. Paying
  down a debt needs no credit.
- A hundred payments through one hub land in one block. Payments in a block
  commute: two networks that commit the same block in opposite orders end up
  the same.
- When a rush asks a line for more than it has, the runtime trims it to the
  limit.
- A cut and a payment that together overdraw one line cannot both land, in
  either order. A limit cannot be cut below what is owed. A raise counts from
  the next block.
- A cycle of debts clears with a payment to yourself.
- A payment splits over routes, or none of it moves. Routes that share a line
  take from its one room, up to what it has.
- A pair opens once, changes once a block, and closes once. Its bond goes back
  to whoever opened it.
- Bad limits and routes are refused. The largest payment fits, and the network
  starts once.
- Under the network's default storage prices, bonded pairs cost the network
  nothing, and payments create no storage. Without a bond, opening pairs drains
  the network.

Expected exceptions can appear in the output; the final result is what
determines success.

With the CLI installed, `thruput test -p mutual-credit` builds the contract and
runs the largest payment in the RV32 guest: four routes of six members each,
which is 28 hops, every one on a bonded pair.

## How a payment moves

From [the first test](tests/test.rs): Bob trusts Alice with 100, and Carol
trusts Bob with 100.

| Payment                     | Alice owes Bob | Bob owes Carol | Alice | Bob | Carol |
| --------------------------- | -------------: | -------------: | ----: | --: | ----: |
| (start)                     |              0 |              0 |     0 |   0 |     0 |
| Alice pays Carol 30 via Bob |             30 |             30 |   −30 |   0 |    30 |
| Carol pays Alice 20 via Bob |             10 |             10 |   −10 |   0 |    10 |

A pair of members has two rooms, one for each side. Bob's room for Alice is his
limit less what she owes him: 100 − 30 = 70 after the first payment. Alice
extends Bob no credit, but her room for him is 0 + 30 = 30. Bob may come to owe
her 30 more, because that only pays her debt down. A payment from Alice to Bob
takes from Bob's room and gives to Alice's. So the two rooms always add up to
the two limits.

Carol's payment back runs the other way: Carol to Bob, then Bob to Alice. Each
hop pays down a debt, so it takes from a room that the debt filled, and nobody
has to trust Carol. Past what is owed, the same payment needs credit that
nobody has given, and it is refused.

## Clearing a cycle

Alice owes Bob 10, Bob owes Carol 10, and Carol owes Alice 10. Everyone's
position is zero, but every line is used up. Alice pays herself 10, round the
cycle the other way: Alice to Carol, Carol to Bob, Bob to Alice. Each hop pays
down a debt, so the payment needs no credit, even if every limit has been cut
to what is owed. The debts cancel and nobody's position changes. Anyone on a
cycle can clear it, and everyone on it gains, because their lines are free
again. Round the cycle the way the debts run, the same payment would need new
credit, and it is refused.

## Why it holds up

- **No line can go past its limit.** The runtime checks a block's takings from
  a room against its value at the block's start. What a block gives, such as a
  payment the other way, counts from the next block. When a rush asks a line
  for more than it has, the payments that fit commit. The rest are turned away
  with `BoundsExceeded`, and nothing they did is kept. The contract also checks
  each hop against the room at the block's start, so a payment that could
  never fit gets a clear error, `NotEnoughCredit`.
- **A creditor can always cut, but not below the debt.** A cut takes from the
  room at once, so the runtime checks it against the payments in its own block
  too. Setting the limit to what is owed stops any more borrowing.
- **You risk only what you extend.** A payment through you leaves your position
  where it was: you are owed by the member before you what you owe the member
  after you. If the member before you never pays, you lose what you trusted it
  with, and no more.
- **Payments create no storage.** Opening a pair creates its terms and both its
  rooms, and a payment only adds to and takes from rooms. So payments cost the
  network nothing, and a flood of them fills nothing. A route through two
  members with no pair is refused before it writes anything.
- **Members pay for their own storage.** A pair is three data items in the
  network's storage, paid for out of the network's own native tokens. Without a
  bond, anyone could open pairs until those tokens ran out, and from then on
  nobody could open a pair. `pair_bond` makes whoever opens the pair deposit the
  cost instead, and `close` returns it. Integers are stored in as few bytes as
  they need, so a pair's terms grow as its limits do. `pair_storage_cost` prices
  a pair at its largest: 36,860 base units (0.003686 native tokens) under the
  default cost model. Opening takes an exclusive lock, so each pair is bonded
  once.
- **A pair's limits change once a block.** `set_limit` computes the change from
  the limits at the block's start. Two changes to one pair in a block would
  both start from there, so the terms are written with an exclusive lock, and
  the second conflicts. That holds even for the same change sent twice: two
  identical writes do not conflict on their own. Payments never read the terms,
  so a limit change never holds one up.
- **A close happens once.** It deletes the pair with an exclusive lock, so a
  second close in the same block cannot commit. With both limits at zero, both
  rooms are zero, so no payment in that block can touch the pair. A limit set in
  that block conflicts with the close.
- **No step can be clogged.** A payment makes at most 28 hops, and updates two
  rooms at each. A limit change and a close each touch one pair. Nothing loops
  over members, and there is no crank or settlement for anyone to hold up. In
  the guest, the largest payment costs about 1.2M gas, opening a pair 0.16M,
  and a close 0.09M, against a cap of 1,000M.

What it does not protect against:

- **Default.** A debtor can walk away. Nothing on chain makes it pay. Mutual
  credit relies on each member choosing whom to trust, and how far. Keep each
  limit to what you would lend that member.
- **Being rippled through.** When you extend credit to someone, they can pay
  through you to anyone who extends credit to you. Your position does not move,
  but you can end up owing one member where you were owed by another. Some
  networks let a member refuse this; see [Try a change](#try-a-change).
- **Order decides who gets scarce room.** While lines have room, nothing in a
  block depends on its order. When a block asks a line for more than it has,
  the payments committed first get in, and the block producer chooses that
  order.
- **Routing is the payer's job.** The contract checks a route; it does not find
  one. A wallet can build the graph from `LineSet` and `Paid` events, and check
  rooms with `line`. Rooms change as payments land, so a route can be stale by
  the time its payment does. Then the payment is refused whole, and can be
  retried on another route.
- **A credit is worth what members agree it is.** It is not redeemable for
  anything. A network usually names its unit (an hour of work, or a currency),
  but the contract does not.

## Use it

Deploy the network and call `initialize(pair_bond)` in one transaction. Before
or during that transaction, send the network's address enough native tokens for
its deployment and for [`reserve_needed`](src/implementation.rs). That covers
the network's own storage, and lets `close` refund a bond before the deletions
are settled. Set `pair_bond` to at least `pair_storage_cost(baseDataItemCost,
bytestringCostPerByte)`, from the RPC's storage costs.

A member grants the network an allowance on the native token for bonds, and
then calls `set_limit(debtor, limit)` to extend credit. The first limit between
two members opens their pair and takes the bond. To pay, a member finds routes
with room, and calls `pay(to, routes)`. A route lists the members between payer
and payee; an empty route pays the payee directly. To leave, both members cut
their limits to zero once nothing is owed, and either calls `close(other)`.

## Read

1. [Implementation](src/implementation.rs): `hop` for what a payment takes and
   gives, `set_limit` for opening a pair and moving a limit, and `close`.
2. [Native tests](tests/test.rs): `env.transaction().build()` executes several
   transactions before any of them commits, which is how a test puts them in
   one block. `conflicts` shows why a transaction was left out.
3. [RV32 test](tests/test_rv32.rs): the largest payment, in the guest.

## Try a change

In `set_limit`, write a changed pair's terms with `set` instead of
`set_exclusive`, and rerun. `the_same_raise_twice_in_a_block_lands_once` fails,
because both raises now commit. Two identical writes to one key do not
conflict. Remove the check of the second result, and the test shows the
damage: the limit rose from 100 to 150 once, but the room rose twice, to 200.
Alice could now owe Bob 200 on a limit of 150, and the line reports that Bob
owes Alice 50.

Then let members refuse to be rippled through. Add a
`Map<ContractAddress, Value<bool>>` that a member sets for itself, and in `pay`,
refuse a route through a member who has not set it. The tests that route
through Bob or the hub fail until they opt in. Clearing a cycle is a payment
through the others on it, so they have to opt in for that too, even though it
only pays their debts down.
