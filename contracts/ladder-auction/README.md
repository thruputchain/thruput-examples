# Ladder auction: a sale where bid order cannot matter

A uniform-price auction for a fixed supply of a token. The seller sets a ladder
of prices; a bid names a level of the ladder and a number of lots. When bidding
closes, the price is set by the highest level at which the bids at or above it
ask for the whole supply. Every bid above that level is filled in full, the bids
at it share what is left in proportion to their size, and the bids below it are
refunded. Everyone filled pays that one price, which is never more than they bid.

What makes this a Thruput example is what a bid does: it escrows its payment and
adds its lots to two totals, one for its level and one for the bidder. It reads
neither. So any number of bids, in one block, at one level, commit together
without conflict, and none can see another. The state after a block is the same
however its bids were ordered, and so is the outcome. Going first, front-running,
or a block producer's choice of order gains nothing. On a chain that runs
transactions one at a time, a popular sale is a race to be first; here it is a sum.

Read [Counter](../counter/README.md) and [Waitlist](../waitlist/README.md) first.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, without a node or npm:

```sh
cargo test -p ladder-auction --locked --test test
```

Expected: **10 tests pass**. A sale clears from the top at one price. An
undersubscribed sale clears at the reserve and returns the rest. What rounding
leaves over goes back to the seller. A hundred bids in one block all commit, and
two auctions that commit the same bids in opposite orders settle identically. A
bidder's first bid at a level is bonded once, and later bids at that level merge.
A bidder claimed for twice in one block is paid once. Bidding closes at the end.
Bad terms are refused. Under the network's default storage prices, bonded bids
cost the auction nothing, and unbonded bids drain it. Expected exceptions can
appear in the output; the final result is what determines success.

With the CLI installed, `thruput test -p ladder-auction` builds the contract and
runs the largest claim (a full 32-level ladder with one bidder at every level)
in the RV32 guest, whose memory is fixed.

## How a sale clears

From [the first test](tests/test.rs): 10 lots for sale, prices 10, 20, 30, and
40 a lot.

| Bidder | Bid             | Escrow | Filled | Pays | Refund |
| ------ | --------------- | -----: | -----: | ---: | -----: |
| Alice  | 6 lots at 40    |    240 |      6 |  180 |     60 |
| Bob    | 6 lots at 30    |    180 |      4 |  120 |     60 |
| Carol  | 4 lots at 20    |     80 |      0 |    0 |     80 |

Walking down from the top: bids at 40 ask for 6 of the 10 lots; bids at 30 or
more ask for 12. So 30 clears. Alice is filled in full, Bob's 6 lots share the 4
that are left, and Carol is refunded. Everyone filled pays 30 a lot, and the
seller receives 300.

There is no settlement transaction. Once bidding closes, the demand curve cannot
change, so the clearing is a pure function of it. Each claim recomputes it, at
one read a level, and settles one bidder: their lots, the seller's payment, and
the refund. The `clearing` view gives the same answer before the end, as what
would clear if bidding closed now.

## Why it holds up

- **Order cannot matter.** `bid` writes two additions and reads no total. Two
  transactions' additions to one key merge, so bids never conflict with one
  another, and no bid can see another in its block.
- **A claim pays once.** It deletes the bidder's entries with an exclusive lock,
  so a second claim for the same bidder in the same block cannot commit, and one
  in a later block finds nothing. A plain delete would not do: two deletes of
  one key do not conflict.
- **Bidders pay for their own storage.** A bidder's first bid at a level opens
  an entry in the auction's storage. Storage is paid for out of the auction's
  own native tokens: 12,000 base units (0.0012 native tokens) an entry under the
  default cost model. Without a bond, anyone could open entries until the
  auction's tokens ran out, and from then on every bid that opens an entry would
  be refused. `entry_bond` makes the bidder deposit that cost instead, and
  the claim returns it. Opening takes an exclusive lock, so each entry is bonded
  once.
- **Shared storage is created up front.** A key that many transactions in one
  block find missing is created by each of them, and each holds a deposit for
  it until the block closes. `initialize` creates the demand totals and counters,
  so a crowd's first bids at a level do not each need a deposit.
- **No step can be clogged.** A bid does a constant amount of work. A claim reads
  at most two balances for each of at most 32 levels, and makes at most four
  transfers. Nothing loops over bidders, and there is no crank or settlement for
  anyone to hold up.
- **No tokens are stranded.** Shares of a rationed level are rounded down. What
  that leaves over is known once every bid at that level is claimed, and
  `return_unsold` returns it to the seller then. Anyone may claim for anyone,
  because the tokens only go to the bidder and the seller, so the seller can
  finish the claims without waiting for bidders.

What it does not protect against:

- **Bids are public.** A late bidder can see the demand curve. A uniform price
  limits the benefit, because a late bid pays the same price as everyone else,
  but a sealed auction needs a commit-reveal phase.
- **The seller can bid too.** A seller's bid raises the price for others, but
  never above any bidder's own limit.
- **Block producers choose what to include.** One can leave bids out of the
  final block, and the block's timepoint decides which block is final.
- **Tokens are trusted.** The sale and payment tokens are whatever the seller
  names, and each pays for its own holder rows.
- **Bids are final.** They cannot be withdrawn, which keeps bidders from
  placing bids to mislead others and withdrawing them before the end.

## Use it

The seller deploys and calls `initialize(terms)` in one transaction. The caller
is the seller. It moves `supply * lot_size` sale tokens in on an allowance.
Before or during that transaction, the seller sends the auction's address enough
native tokens for its deployment and for
[`reserve_needed`](src/implementation.rs). The reserve covers the auction's own
storage and lets a claim refund bonds before its deletions are settled. Set
`entry_bond` to at least the network's per-item storage cost
(`baseDataItemCost` in the RPC's storage costs).

A bidder grants the auction allowances on the payment token and, for bonds, the
native token. They then call `bid(level, lots)` as often as they like until the
end. After the end, anyone calls `claim(bidder)` for each bidder and
`return_unsold()` once.

## Read

1. [Implementation](src/implementation.rs): `bid` for the two additions,
   `clear` for the walk down the ladder, `claim` for the exclusive delete and
   the payouts, and `reserve_needed` for what a seller funds.
2. [Native tests](tests/test.rs): `env.transaction().build()` executes several
   transactions before any commits, which is how a test puts them in one block.
   `conflicts` shows why a transaction was left out.
3. [RV32 test](tests/test_rv32.rs): the largest claim, in the guest.

## Try a change

In `claim`, replace `entry.delete_exclusive()` with `entry.delete()` and rerun.
`a_bid_claimed_twice_in_one_block_settles_once` fails: both claims commit, and
Alice is paid twice.

In `bonded_bids_pay_for_their_own_storage`, halve the bond (`item() / 2`) and
rerun. Each entry now costs the auction the other half, until its reserve runs
out. After that, bids are refused.
