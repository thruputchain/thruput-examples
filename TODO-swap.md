# Proposal: Collapse swap-pair into the swap-handler contract

Motivation: The `swap-pair` contract is meant to mirror the equivalent contract
in UniswapV2, and we'd like to retain its interface as much as possible to
demonstrate how it has been "ported" without much modification into groundhog.
But the batch-handling wrapper we apply makes the `swap-pair` implementation
effectively "internal", and the contract boundary between it and `swap-handler`
is not necessary. Although we could enforce that only the handler calls
`swap-pair`, it is less complex (and probably slightly more efficient) simply
to embed the pair implementation in the handler.

Proposed changes:

- The `swap-pair` implementation moves to `engines/swap-pair`: the same crate
  name, no longer a contract -- just the underlying swap implementation.
  - `request-id` arguments are removed; instead, the operations return
    information sufficient for their callers to generate appropriate events.
  - Tests against the `swap-pair` contract are replaced, where possible, by
    tests that simply execute the pair code. (Tests at this level are less
    important than those against the driver and router; if necessary, some
    testing could be moved to the handler as well.)

- `swap-handler` depends on `swap-pair`, calling it directly where it
  previously made cross-contract calls into it.  It now emits swap events
  itself.

## Plan

### The crate

`contracts/swap-pair` becomes `engines/swap-pair`: the same package name, no
longer a contract.  It loses `main.rs`, its `#[contract]` impl and its
`interface.rs` re-exports; it keeps `pair.rs`, `reserves.rs` and `u256.rs`.
`engines/*` joins the workspace members, and the README's test table gains a
row (native tests only, like `helpers/*`).

`swap-if` keeps `SwapPairError` — the handler's `throws` names it, and swap-if
cannot depend on the pair crate without a cycle — and loses the `SwapPair`
trait, `SwapPairClient` and `SwapPairClientError`.

The pair's operations become inherent methods with their present names, each
documented against its UniswapV2Pair counterpart.  No trait: with one
implementation it would be indirection whose only job is documentation, and the
doc comments do that job directly.

### Signatures

Dropping `request_id` also lets `sender` go, and that is worth noticing rather
than treating as incidental.  `sender` was only ever event data — the pair's own
docs say it "does not affect" the outcome — so once the handler emits the
events, the pair has no use for it:

```rust
fn mint_lp(&mut self, recipient: &Address) -> Amount;
fn burn_lp(&mut self, recipient: &Address) -> Amounts;
fn swap(&mut self, amount0_out: Amount, amount1_out: Amount, recipient: &Address) -> Amounts;
fn skim(&mut self, to: &Address);
fn sync(&mut self);
```

`recipient` stays because it is functional — it is who receives the LP, the
proceeds, the output.  `swap` starts returning the input amounts, which is what
its event needs and the only thing the handler cannot already work out.

This is *closer* to UniswapV2, not further: there the pair takes no sender
either, and uses `msg.sender` for the event.  Here the handler is what
`msg.sender` was, so the attribution belongs to it.

### Storage

The pair's state becomes a `#[derive(Storage)]` struct the handler holds as a
field, so its keypaths are namespaced under it:

```rust
#[storage]
pub struct Handler {
    cfg: Value<Cfg>,
    pair: Node<Pair>,
}
```

Custody moves with it: the handler becomes the pool's token holder, so
`transfer_amounts_from(owner, to: pair)` becomes a transfer into itself, and the
balance-delta accounting reads the handler's balances.  One address fewer in the
story.

### Events

The pair keeps emitting `SyncEvent` — it is emitted deep inside
`reserves.rs::update`, carries reserves, and attributes nothing — and the
handler emits `MintEvent`, `BurnEvent` and `SwapEvent`, which are exactly the
ones carrying a sender and a request id.

That line is the whole point of the exercise: **an attributed event belongs to
whoever can vouch for the attribution.**  The alternative, of the pair emitting
nothing, would mean threading updated reserves back out of every operation so
the handler could emit `SyncEvent` on its behalf — cost with no benefit.

Those three events will then be emitted by the handler's address rather than the
pair's, which matters to anyone filtering by contract address.

### The handler's surface

`SwapHandler::initialize` takes what the pair used to be told — it adopts and
administers the LP token itself, and needs the factory for the protocol
`fee_to`:

```rust
fn initialize(&mut self, factory: &Address, token0: &Address, token1: &Address, lp_token: &Address);
```

It also grows the views the outside world used to read from the pair —
`get_reserves`, `get_liquidity`, `get_cumulative_prices`, `liquidity_token` —
and `skim`/`sync`, which stay open to anyone as in UniswapV2.  The handler
becomes the pool's public face.

### The factory

A pool becomes three contracts instead of four: LP token, handler, driver.
`SwapHashes` and `Role` lose their `pair`, `Pool` loses its `pair` address, and
`create_pair` deploys and initializes one contract fewer.

### Tests

The pair's tests keep their present shape.  A test can open a frame at an
address with no contract deployed there and run pair code in it, in the same
transaction as the deposit that feeds it — verified against the mock
environment:

```rust
tx.call(ALICE.addr).run_continuable(|frame| {
    ctx.token0().transfer(&PAIR_ADDR, 1_000);        // as Alice
    frame.child_call(&PAIR_ADDR).run(|| {            // pair code, at the pair's address
        assert_eq!(ctx.token0().get_balance(), 1_000);   // sees the deposit
        // ... storage writes land at PAIR_ADDR
    });
    FrameAction::Close
})
```

So `user_buy` and `user_redeem` survive intact: one transaction, one block, with
`pair.mint_lp(..)` becoming pair code run in a child frame.  What would have
forced them apart — a caller check — is exactly what this change removes.

Since `run_continuable` is clumsier than `run`, an `Etx::exec_as_pair(user,
deposit, op)` helper should absorb the pattern so the churn lands in one place
rather than at every call site.

Two details:

- The address the pair runs at pays for its own storage under the default cost
  model, so it needs `setup_grant_storage_tokens` like any deploy target.  (Its
  absence surfaces as a bare `ExecResult(3)`, which is easy to misread.)
- `swap-pair`'s own tests can use a dedicated `PAIR_ADDR`, which keeps reading
  as "the pair"; `swap-driver` and `swap-router` should use
  `ctx.request_handler_addr`, where production puts it.  The pair only ever
  refers to "my own address", so both work.

`swap-factory`'s protocol-fee measurement needs rework of a different kind: it
reads the cost of an *invocation of the pair*, and there will not be one.  It
should measure the frame that runs the liquidity event instead.

### The app

`apps/swap` reads `getReserves` from the pair (`pair-adapter.ts`,
`setup-local.ts`) and — the part easy to miss — filters events by
`config.pairAddress` in its request observer.  With the pair gone, both point at
the handler instead, and the generated bindings lose `swap-pair.ts`.  The app is
otherwise unaffected: it already seeds liquidity through
`addLiquidity` + `processRequests` rather than by touching the pair.  This is an
`APP-CHANGES.md` entry, not work in this change.

### Afterwards

The per-request gas budgets in `swap-if` are calibrated against a cost that
includes a cross-contract call per operation, which this removes.  They should
be re-measured — `request_gas` and the protocol-fee test give the figures — and
will fall.

### What this does not change

The pair was one of three unpermissioned boundaries, and the least harmful.
`SwapDriver::request` and `SwapHandler::handle_request` both still take a
caller-supplied `SwapRequest` naming any account as the sender, and the handler
spends that account's token allowance — so anyone can enqueue, or directly
execute, a request that pays out of someone else's approval.

Collapsing the pair does not touch that, and makes the handler the custodian of
the pooled tokens besides.  What it does do is leave one boundary to fix instead
of three, with the same remedy for both: admit only your predecessor, with the
router as the entry point that records the true caller.
