# Pigment: a shared canvas where strokes mix

A canvas anyone can paint on, a unit of paint at a time, for a price. A pixel
shows the mean of the colours painted on it, weighted by how much of each. A
unit of red and a unit of blue make purple, and covering a colour takes more
paint than it has. Paint is wet through the epoch it goes on in, and fades away
through the next. Then it is gone, so the canvas keeps changing.

What makes this a Thruput example is what happens when many people paint one
pixel at once. On a chain that runs transactions one at a time, a shared canvas
is a race. Each stroke overwrites the pixel, and whoever is ordered last wins.
Here a stroke is an addition: it adds its paint to the pixel and reads nothing
that another stroke in its block writes. So any number of strokes on one pixel,
in one block, all commit and mix. The block ends with the same colour whatever
order they were in. Strokes do not collide; they blend.

Read [Counter](../counter/README.md) and [Waitlist](../waitlist/README.md) first.

## Run

Complete the [Rust setup](../../README.md#rust-and-cli).
From the repo root, without a node or npm:

```sh
cargo test -p pigment --locked --test test
```

Expected: **11 tests pass**. A stroke colours its pixel, and its painter pays
the beneficiary for each unit. Strokes mix by amount. Sixty painters paint one
pixel together, in the first block of an epoch and again in a later block, and
every stroke commits, in either order. Paint fades through the next epoch and
is gone after it. A pixel reused two epochs later starts over. A pixel holds a limited amount of paint
each epoch, and a block that asks for more is trimmed. A row comes back packed.
Under the network's default storage prices, painting never costs the canvas a
deposit, and a canvas that cannot pay for its storage cannot be laid out. Bad
terms and strokes are refused. Expected exceptions can appear in the output;
the final result is what determines success.

With the CLI installed, `thruput test -p pigment` builds the contract and runs
the heaviest calls in the RV32 guest: laying out a 64 by 64 canvas, a paint of
64 strokes that each start a pixel over, and reading a full row.

## How strokes mix

From [the tests](tests/test.rs), in one epoch:

| Stroke           | Pixel holds          | Shows                               |
| ---------------- | -------------------- | ----------------------------------- |
| 3 units of red   | 3 red                | red, `#FF0000`                      |
| 1 unit of blue   | 3 red, 1 blue        | `#BF003F`: 3/4 of red, 1/4 of blue |
| 5 units of blue  | 3 red, 6 blue        | `#5500AA`: 1/3 of red, 2/3 of blue |

In the next epoch, that paint fades. A quarter of the way in, a quarter of it is
gone. New paint goes on at full weight and mixes with what is left. By the end
of that epoch, the old paint is gone.

A pixel keeps its paint in one integer for each epoch, called a coat. The
integer packs four sums side by side: how much paint, and for red, green, and
blue, each stroke's amount times its value in that channel. A stroke adds its
own packed integer, which adds to all four sums at once. Any number of
transactions in a block can add to one integer, which is why strokes merge.
The mixed colour is each channel's sum divided by the amount. See
[`coat.rs`](src/coat.rs).

## Why it holds up

- **Order cannot matter.** A stroke reads its pixel's coat as of the block's
  start, then adds to it. Additions from any number of transactions merge, so
  no stroke can see another in its block, or be undone by it.
- **Epochs start over without a reset step.** Each pixel has two coats, one for
  even epochs and one for odd. The current epoch's coat is wet, and the previous
  epoch's coat is fading. When an epoch begins, the coat it reuses is two epochs
  old. The first strokes on it set it to an empty coat for the new epoch, then
  add to it. Every transaction in that block reads the same stale coat and sets
  the same value, and identical sets of one key do not conflict. No one has to
  clear the canvas, and no step waits on anyone.
- **The runtime caps each coat.** The amount of paint is the top lane of an
  `i128`. A coat that held more than `MAX_DEPTH` (131,071) units would overflow
  the integer. The runtime checks the merged total of a block's strokes and
  refuses a transaction that would take it past that, with `BoundsExceeded`.
  Each colour sum is at most 255 times the amount, so it cannot overflow into the
  next lane. One stroke over the limit by itself is refused with `PixelFull`.
- **Painting never grows storage.** `initialize` lays out both coats of every
  pixel, and the canvas pays the deposits then. A stroke only rewrites a coat.
  However much anyone paints, the canvas stores the same amount of data, and no
  one can drain its native tokens by painting. This also avoids a cost that
  shared new keys would have. A key that many transactions in one block find
  missing is created by each of them, and each holds a deposit until the block
  closes.
- **Every call is bounded.** A canvas is at most 64 by 64, so laying it out
  writes at most 8,192 integers. A paint makes at most 64 strokes, each a read
  and one or two writes. A row reads two coats for each of at most 64 pixels and
  returns four bytes for each pixel, which fits the 1,024-byte return buffer.
  Nothing loops over painters, and there is no crank.
- **Influence costs money.** Every unit costs `price` native tokens, paid
  straight to the beneficiary. The canvas holds no funds and has no owner.
  Filling a pixel for an epoch costs `MAX_DEPTH * price`. It takes no new paint
  until the epoch ends, and its paint fades through the next.

What it does not protect against:

- **Money is influence.** Whoever pays for the most paint on a pixel decides its
  colour. That is the game, but set `price` with it in mind.
- **A full pixel can turn others away.** Paint in one block that takes a pixel
  past its limit causes the over-limit transactions to fail at commit. Their
  painters can send them again in a later epoch. Filling a pixel costs the
  full amount of paint.
- **Block producers set the clock.** A block's timepoint decides its epoch, and a
  producer chooses which strokes to include.
- **Epochs are tracked modulo 2^32.** A coat untouched for exactly 2^32 epochs,
  more than a century at the shortest epoch, would be taken for current.
- **The beneficiary needs a native balance.** A native balance pays for its own
  storage. If a payment cannot create one, its paint cannot commit.

## Use it

Deploy the contract and call `initialize(terms)` in one transaction. Before or
during that transaction, send the contract enough native tokens for its
deployment and for two integers a pixel. The per-item cost is
`baseDataItemCost` in the RPC's storage costs. The terms set the size, the
epoch length in nanoseconds, the price of a unit, and the beneficiary.

A painter grants the canvas a native-token allowance, then calls
`paint(strokes)`. Each stroke is a pixel, a colour as `0xRRGGBB`, and an amount.
`row(y)` returns what a row shows, each pixel as `0xRRGGBBAA`. The alpha is how
much of the pixel's paint has not yet faded. `pixel(x, y)` adds the wet and
fading amounts behind it. Each stroke emits a `Painted` event, for a client
that draws the canvas as it changes.

## Read

1. [Coat](src/coat.rs): the packed integer, why no lane can overflow, and
   `mix`, which weighs the wet and fading coats.
2. [Implementation](src/implementation.rs): `paint` for starting a coat over
   with an identical set, then adding to it, and `initialize` for laying out
   the canvas.
3. [Native tests](tests/test.rs): `env.transaction().build()` executes several
   transactions before any commits, which puts them in one block.
   `conflicts` shows why a transaction was left out.
4. [RV32 test](tests/test_rv32.rs): the largest canvas, in the guest, with the
   gas each call spends.

## Try a change

In `paint`, use `self.coats.at_mut_exclusive(...)` instead of `at_mut`, as if
to stop two painters from starting a coat over at once, then rerun.
`a_crowd_paints_one_pixel_in_one_block_in_any_order` fails. The first stroke
on the pixel takes its lock, and every other stroke on it in that block is
turned away with `ExclusiveLockDenied`. With a lock, each pixel takes one
painter per block, as it would on a chain that runs transactions one at a time.

To make paint last longer, keep three coats a pixel (`3 * p + e % 3`), lay out
three, and read the two coats before the current one as fading.
`paint_is_wet_for_its_epoch_then_fades` then fails at epoch 2, because the red
is still there. Update its expectations.
