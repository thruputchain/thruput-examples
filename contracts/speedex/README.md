# Speedex

An example port (not for production) of [SPEEDEX], a batch exchange, to Groundhog: several assets,
one set of valuation prices per batch, and every offer in the batch trading at those prices.

- [`engine`](src/engine.rs): the arithmetic -- the limit-price grid, tâtonnement over aggregate
  supply and demand, the circulation that turns its prices into exact trades, and the rule that
  settles one offer. Plain functions over plain numbers, with no storage behind them, tested on their
  own in [`tests/engine.rs`](tests/engine.rs).
- [`contract`](src/contract.rs): the exchange -- escrow, the per-batch histogram, the clearing
  record, and settlement -- tested end to end against the `erc20` example in
  [`tests/batch.rs`](tests/batch.rs), and on the RV32 artifact in
  [`tests/test_rv32.rs`](tests/test_rv32.rs) (`groundhog test -p speedex`).

## What SPEEDEX is

A conventional exchange keeps an orderbook per pair of assets and matches offers one at a time, in
arrival order. SPEEDEX instead collects offers into a batch and finds one *valuation* per asset --
`p_A`, `p_B`, `p_C`, ... -- such that at the exchange rates those valuations imply (`p_A / p_B`
units of B per unit of A), the amount of every asset offered for sale is met by the amount of it
that other offers want to buy. Every offer whose limit price the batch rate beats then executes, all
at that same rate.

Two things follow. There is no ordering inside a batch, so there is nothing to front-run and offers
commute. And an offer to sell A for B can be filled by someone selling B for C and someone else
selling C for A: the valuations clear a ring of trades that no pairwise orderbook could match
(`tests/batch.rs::ring_trade_clears_through_three_assets`). That is why this example insists on at
least three assets -- with two, a batch is just a call auction.

The valuations are found by *tâtonnement*: start anywhere, raise the price of whatever is
over-demanded, lower the price of whatever is over-supplied, repeat. Demand is a step function of
price (an offer executes or it does not), so SPEEDEX smooths each step over a narrow band, which
gives the iteration a gradient to follow; and since the prices it finds are only approximately
clearing, a final pass makes the trades exactly feasible, so that the exchange never pays out more
of an asset than it took in. SPEEDEX uses a linear program for that pass; see below for what this
example does instead.

## How it is laid out on Groundhog

Groundhog executes a block's transactions against the state the block began with and then merges
their writes, so a contract runs in parallel exactly to the extent that its writes are *blind
deltas* -- an `NNInt` increment, a fresh key -- rather than values one transaction must read after
another wrote. SPEEDEX's structure maps onto that almost directly, because the price computation
depends only on the batch's aggregate supply and demand, never on individual offers or their order.

**Submitting an offer** (`submit_offer`) escrows the seller's tokens (from an allowance to the
exchange), rounds the limit price up to a grid level, and adds the amount to one histogram cell:
this batch, this orderbook (sell asset, buy asset), this level. The cell is an `NNInt`, so any
number of offers land in one block without contending. The offer itself is recorded under an id
that names its submission and commits to its contents. Offers join the batch of the block they are
made in (batches span `epoch_len` blocks), and can be cancelled until the batch closes.

**Clearing a batch** (`clear_batch`) runs once, after the batch's last block, and may be run by
anyone: it is a pure function of the histogram, so everyone gets the same answer. It reads the
histogram -- `n (n - 1) * levels` cells, however many offers were made -- runs the engine, and
records the resulting prices and each orderbook's trades. This is the one thing in
the design that runs alone, and its cost does not grow with the number of offers.

**Settling an offer** (`settle_offer`) pays one offer from that record and its own entry: what it
bought, and a refund of what it did not sell. It touches nothing another settlement touches, so a
batch's offers settle in any order, any number to a block, alongside the next batch's submissions.
Anyone may settle any offer; the proceeds go to its owner.

The parallelism is therefore the same as SPEEDEX's own: everything is order-free except one small
per-batch step whose cost is independent of load.

## Simplifications

- **A price grid.** Limit prices live on a geometric grid, eight levels to the doubling, over
  `octaves` doublings either side of one (`engine::level_ratio`). That is what makes an orderbook a
  histogram rather than a sorted list. An offer's limit is rounded *up* to the next level, so a
  seller never trades below what it asked, but may occasionally miss a trade it would have taken.
- **One-shot offers.** SPEEDEX keeps unfilled offers resting for later batches. Here a batch is a
  one-shot auction: what it does not fill is refunded at settlement, and the seller may resubmit.
- **No fee, and the LP as a circulation.** SPEEDEX's linear program picks how much each orderbook
  trades so that no asset is paid out beyond what was sold of it. Without a fee those constraints
  sum to zero across assets, so they hold with equality: value in equals value out at every asset,
  and the problem is a circulation on the graph of assets with one edge per orderbook. That has an
  integral solution, so `engine::clear` finds it in exact integers -- a minimum-cost circulation by
  cycle cancelling in `U256` -- rather than with an LP solver in floating point. Each edge has two
  arcs: the value of the buckets past the smoothing band, which is filled first (a cycle can never
  profitably trade it for marginal volume), and the value of the buckets inside the band. Within a
  book, levels fill from the most in-the-money down, and the marginal level's offers share its
  remainder. Rounding at settlement goes the exchange's way by under a unit per offer, and the
  circulation makes what the exchange must pay out of each asset at most what it took in; the dust
  simply stays. Where every book on a cycle is past the band, approximate prices cannot balance
  the cycle exactly and a little of it goes unfilled; the clearing reports that value as its
  `shortfall`.
- **Deterministic tâtonnement from equal prices.** SPEEDEX warm-starts from the previous block and
  lets the proposer's result stand. Here every clearing starts from equal prices so that the
  clearing is a pure function of the batch, at the cost of some extra rounds. A batch in which no
  offer executes at equal prices can execute nothing at any prices -- every offer would want more
  than one of its buy asset per unit sold, and a trade is a cycle of sales whose rates multiply to
  one -- so such a batch returns at once and refunds everything.

## Bounds

Prices are Q32 fixed point, normalized so the largest is `2^56` and none is below `2^8`, so no rate
exceeds `2^48`; offers are between `2^16` and `2^80`. Within those, every per-offer product fits
`u128`. A histogram cell is an `i128` and may total anything up to `i128::MAX` (the increment
refuses more); the circulation works in value, amount times price, which is under `2^184` per
edge and is exact in `U256`. The grid bounds the rates that can actually trade far more tightly
than that.

An exchange may have at most `MAX_CELLS` (1024) histogram cells -- `n (n - 1) * levels` -- since a
clearing reads every one of them whether or not it is occupied. That bounds a clearing's cost, but
does not measure it: the mock environment used by the tests does not meter gas the way a node does,
so calibrate on a devnode (as `scripts/swap-gas-calibrate.sh` does for the swap example) before
choosing a configuration near the bound.

The chain caps a contract's code at 64 KiB, and RV32 has no 128-bit multiply or divide, so the
engine's arithmetic is expensive in code. The engine's routines are `#[inline(never)]` so that each
exists once rather than once per entry point, and the workspace `Cargo.toml` builds this package at
`opt-level = "s"`.

## Running

```sh
cargo test -p speedex                        # engine and contract tests, natively
groundhog build -p erc20 -- -F metadata      # the RV32 artifacts the next line loads
groundhog build -p speedex
groundhog test -p speedex                    # the ring trade on the RV32 artifact
```

[SPEEDEX]: https://www.usenix.org/conference/nsdi23/presentation/ramseyer
