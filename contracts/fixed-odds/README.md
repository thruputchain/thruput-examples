# Fixed odds: a betting book the runtime keeps solvent

A bookmaker's book on one event. The house quotes fixed odds on each outcome
and puts up a bankroll, and anyone can bet. Exactly one outcome wins and its
backers are paid their odds, or the event is called off and every stake goes
back. The same contract sells cover: a bet on "flight delayed" is insurance
against it.

What makes this a Thruput example is that no bet waits for another, and no
block of bets can leave the house owing more than it holds. For each outcome,
the book keeps a **headroom**: what the house would have left if that outcome
won. A bet takes what it could win beyond its stake from its own outcome's
headroom, and adds its stake to every other outcome's. Each headroom is a
[`CapacityConstraint`](src/implementation.rs). A bet only records what it takes
and adds, and the runtime admits a block's bets while every headroom stays at or
above zero. On most chains, a market maker's exposure is a total that every bet
reads and rewrites, so bets on one market run one at a time, and solvency is a
check inside that queue. Here a hundred bets, spread over every outcome, land in
one block, and the runtime does the check.

Every bet in a block gets the odds quoted at the block's start. A new quote
takes effect from the next block. So the house never conflicts with bettors,
and no bet in a block can change the price that another bet gets.

Read [Counter](../counter/README.md) and [ERC20](../erc20/README.md) first.

## Run

Complete the [setup](../../README.md#setup).
From the repo root, without a node or npm:

```sh
cargo test -p fixed-odds --locked --test test
```

Expected: **16 tests pass**:

- A winning bet is paid its odds, the house settles for the rest, and the book
  ends up empty.
- A hundred bets in one block all commit. Two books that commit the same bets in
  opposite orders end up the same and settle the same.
- A rush on a long shot is trimmed to what the house can cover.
- The house cannot withdraw what a void would refund. A withdrawal and a bet
  that together overdraw one block cannot both land, in either order.
- New odds take effect from the next block.
- A bettor's position is bonded once, and later bets on it merge.
- A bettor claimed for twice in one block is paid once.
- A void returns every stake, and anyone can void a market that the resolver
  abandons.
- Each step happens once and in turn, and a market ends one way.
- The house can add funds at any time. Bad terms are refused.
- Under the network's default storage prices, bonded bets cost the book nothing,
  and unbonded bets drain it.

Expected exceptions can appear in the output; the final result is what
determines success.

With the CLI installed, `thruput test -p fixed-odds` builds the contract and
runs the largest market in the RV32 guest. It has eight outcomes and one bettor
with a bonded position on each, which makes the heaviest bet and claim; the
house's withdrawal there takes from all nine cases.

## How the headroom works

From [the first test](tests/test.rs): a bankroll of 1,000, and odds of 1.9 on
each of two outcomes. A bet at 1.9 pays 1.9 times its stake, the stake included.

| Bet                     | If 0 wins | If 1 wins | If void |
| ----------------------- | --------: | --------: | ------: |
| (start)                 |     1,000 |     1,000 |   1,000 |
| Alice, 100 on 0 for 190 |       910 |     1,100 |   1,000 |
| Bob, 100 on 1 for 190   |     1,010 |     1,010 |   1,000 |
| Carol, 50 on 0 for 95   |       965 |     1,060 |   1,000 |

Alice's bet could cost the house 90 if outcome 0 wins, so it takes 90 from that
headroom. If outcome 1 wins, the house keeps her 100, so it adds 100 to that one.
If the event is called off, her stake goes back, which leaves the house even,
so the void case is untouched.

Outcome 0 wins. Alice is paid 190, Carol 95, and Bob nothing. The house settles
for 965, the headroom of what happened. That leaves the book holding exactly
what the winners are owed, and their claims empty it. There is no settlement
step to crank: the house's share is one number, and each claim pays one bettor.

## Why it holds up

- **The house can never owe more than the book holds.** The runtime checks a
  block's takings from a headroom against its value at the block's start. What a
  block adds, such as stakes on other outcomes, counts from the next block. When
  a rush asks for more than an outcome has, the bets that fit commit. The rest
  are turned away with `BoundsExceeded`, and nothing they did is kept. The
  contract also checks each bet against the headroom at the block's start, so
  a bet that could never fit gets a clear error.
- **Calling the market off is a case too.** A void returns every stake, so its
  headroom is the bankroll, and a bet leaves it alone. The house can withdraw
  only what it would have left in every case, void included. A balanced book
  locks in a profit if either side wins, but the stakes it holds must still go
  back if the event is called off. The runtime checks a withdrawal against the
  bets in its own block too.
- **Bettors do not have to trust the house to pay.** Once a bet lands, the book
  holds its payout. The house can suspend an outcome or change its odds. It
  cannot cancel a bet, withdraw what bets are owed, or stop a claim.
- **One price per block.** Bets read the quote and never write it, and the house
  writes the quote and never reads a bet, so neither conflicts with the other.
  A bet carries `min_odds`, so if the quote moves before the bet lands, the bet
  is refused instead of filled at worse odds.
- **A claim pays once.** It deletes the bettor's positions with an exclusive
  lock. A second claim for the same bettor in the same block cannot commit, and
  one in a later block finds nothing. A plain delete would not do: two deletes
  of one key do not conflict. Claims for different bettors never conflict.
- **Bettors pay for their own storage.** A bettor's first bet on an outcome
  opens a position: its stake and its payout, two data items in the book's
  storage. The book pays for storage out of its own native tokens: 24,000 base
  units for a position under the default cost model. Without a bond, anyone
  could open positions until those tokens ran out. `entry_bond` makes the bettor
  deposit that cost instead, and the claim returns it. Opening takes an
  exclusive lock, so each position is bonded once.
- **Shared storage is created up front.** A key that many transactions in one
  block find missing is created by each of them, and each holds a deposit for it
  until the block closes. `initialize` creates every headroom, so a crowd's
  first bets do not each need a deposit.
- **No step can be clogged.** A bet writes one headroom an outcome, at most
  eight, and makes at most two transfers. A claim reads and deletes at most
  eight positions. Nothing loops over bettors. In the guest, the heaviest bet
  costs about 0.37M gas, a withdrawal 0.47M, and a claim 0.52M, against a cap of
  1,000M.
- **A missing resolver cannot keep the stakes.** If the market is still open
  at `resolve_by`, anyone may void it.

What it does not protect against:

- **Stale odds.** A new quote takes effect from the next block. Bets in the same
  block as the quote, for example the moment a goal is scored, still get the old
  odds. Every market maker carries this risk. Here it is bounded by the headroom,
  and the house sets the bankroll. Close betting before the event, or keep the
  bankroll small while it runs.
- **The resolver is trusted.** It names the winner, and nothing checks it.
  Bettors should check who it is. The house can name itself.
- **Order decides who gets scarce headroom.** The price never depends on where
  a bet sits in a block. But when a block asks more of a headroom than it has,
  the bets committed first get in, and the block producer chooses that order.
- **Tokens are trusted.** The token is whatever the house names.
- **Bets are final.** There is no cashing out before the event.

## Why the book does not move its own odds

An automated market maker would shorten the odds on an outcome as money came in.
This book does not, and the reason is the block. Every bet in a block gets the
same price, however large, and nothing a bet does moves the price until the
next block. Charging large bets more would not help: a large bet can be split
into many small ones in the same block, and each would be priced as if it were
alone.

So if the book moved its own odds, anyone could move them. Bet heavily on one
side at the current price, then back the other side next block at the longer
odds that the first bet produced. With the two bets sized right, the bettor
profits whichever side wins. Here the house decides when to move the odds, with
`set_odds`. The other way out is to price a whole block's bets together, as a
batch auction does; see [Speedex](../speedex/README.md).

## Use it

The house deploys the book and calls `initialize(terms, bankroll, odds)` in one
transaction. The caller is the house, and the bankroll moves in on an
allowance. Before or during that transaction, the house sends the book's address
enough native tokens for its deployment and for
[`reserve_needed`](src/implementation.rs). That covers the book's own storage,
and lets a claim refund bonds before its deletions are settled. Set `entry_bond`
to at least twice the network's per-item storage cost (`baseDataItemCost` in the
RPC's storage costs).

The house calls `set_odds`, `fund`, and `withdraw` as it likes until the
market ends. The resolver calls `resolve(outcome)` after the close, or `void()`
at any time.

A bettor grants the book allowances on the token and, for bonds, the native
token, then calls `bet(outcome, stake, min_odds)` before the close. Once the
market ends, anyone calls `claim(bettor)` for each bettor, and `settle()` once
for the house.

## Read

1. [Implementation](src/implementation.rs): `bet` for the take and the gives,
   `withdraw` for the void case, and `claim` and `settle` for how it ends.
2. [Native tests](tests/test.rs): `env.transaction().build()` executes several
   transactions before any of them commits, which is how a test puts them in
   one block. `conflicts` shows why a transaction was left out.
3. [RV32 test](tests/test_rv32.rs): the largest market, in the guest.

## Try a change

In `withdraw`, leave the void case out: loop over `0..terms.outcomes` only, and
rerun. `the_house_cannot_withdraw_what_a_void_would_refund` fails, because the
house can now take out the 20 that the balanced book would profit if either
side won. In that test, replace the withdrawal of 100 and the checks around it
with `f.call("house", |c| c.withdraw(120));`, and rerun. When the event is
called off, the second refund fails: the book no longer holds the stakes it
owes.

In `bet`, replace `self.take(outcome, payout - stake, ...)` with
`self.give(outcome, stake - payout)`, which skips the contract's own check.
Only one test fails: in `the_runtime_keeps_the_house_solvent`, the bet that
could never fit now gets past the contract, and is turned away when it commits.
The runtime keeps the book solvent; the contract's check only gives a clearer
error.
