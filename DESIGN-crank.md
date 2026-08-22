# swap application: cranking the request queue

## Background

* [groundhog architecture](~/groundhog/developers-site/src/content/docs/how-it-works/)
* [groundhog programming model](~/groundhog/developers-site/src/content/docs/programming-model/)
* In this repository: [swap application](~/groundhog/groundhog-examples/docs/README-swap.md)

_Note:_ The basic swap operations must occur serially, by design.  The suite of
swap contracts is designed to accept many requests for a particular swap pair
into a queue so that they can occasionally be processed in a batch, within one
block.  Without the queue, each request would have to be processed in its own
block, severely limiting the global swap "bandwith" (operations per block).

_Note:_ A particular entity does not likely have an interest in submitting
multiple requests against the same swap pair in the same block, as their effects
could instead be coalesced into one request.

## Current status

The swap contracts may be modified to suit our needs.

Requests submitted to the swap app (via the router -> driver) remain there until
someone invokes `SwapDriver::process_requests`, which processes *some number* of
the waiting requests. For short, we will call this "cranking the queue". The
driver contract may implement its own policy about whether to actually process
requests when the method is called, and how many; servicing many requests
requires a high gas-limit on the cranking transaction.

Submitting a request results in it being stored in a RCQ, incurring storage
costs. If the queue length is capped, the application administrator may be
willing to devote the fixed maximum of hogs required for that storage.

### Constraints and problems

* If the administrator of the swap instance is expected to crank the queue, then
  users must depend on the administrator to be live. Thus it seems that interested
  users must somehow participate in queue-cranking.
* In order to crank the queue, the submitted transaction must provide a
  gas-limit sufficient to process many requests. Currently this means that, in
  order to get the best latency by simultaneously scheduling the
  request-submission transaction *and* the queue-cranking transaction, a user
  would need sufficient free hogs for throughput to cover both.
* If a user were to combine request submission and queue cranking in one
  transaction, the high gas-limit required (approximately proportional to the
  maximum queue length enforced by the driver) could delay the request.
* If users always submit a crank transaction after each request submission, this
  may lead to many _degenerate cranks_ (calls to `process_requests` that result
  in no activity because the queue is empty or because the driver declines to do
  work on a below-threshold queue); furthermore (if the driver is more
  permissive), the queue may not ever build up sufficiently to allow many swap
  operations to occur within one block.

## Goals

We'd like to construct a scheme for cranking that:
- minimizes block-latency for each request (i.e., minimizes the number of blocks
  that pass before it is handled)
- maximizes block-bandwidth (i.e., maximizes the global number of swap
  operations that are handled in each block for a particular swap pair)

The scheme must also align incentives for the users of the application. For
example, if a user requires low latency, the scheme must allow them to somehow
stimulate queue-cranking with an acceptable free-hog encumbrance.  The
application administrator must not have to provide arbitrary amounts of HOG for
storage or throughput.

## What the platform already decides for us

Much of the design space is closed off by the primitives.  The facts below were
checked against SDK 0.19.3, the platform docs, and a set of probes run against
the mock `TestEnvironment` (`sdk/tests/rcq.rs` covers some of them already).

**One crank per block, per pair.** Only one transaction per block may consume
from a given `RCQ`; a second concurrent consumer's delta batch fails
reservation.  The pair would serialize anyway -- `swap_pair` holds
`reserves: Value<Reserves>` and does a read-modify-write on it, so two
reserve-mutating transactions in a block conflict regardless of the queue.
Per-pair, per-block bandwidth is therefore capped at *whatever a single
transaction can do*, under any cranking policy whatsoever.

**A losing crank is deferred, not lost.** Reservation conflicts are
non-deterministic errors: the transaction is excluded from the proposal and
returned to the mempool, to be re-evaluated in a later block
(`ExecResultTxNonDeterministicError`).  This is distinct from a deterministic
abort, which stays in the block with no state change and is *not* retried.  The
mempool is thus already an arbitrator: competing cranks queue up across
subsequent blocks without any client-side coordination.

**A degenerate crank is free and harmless.** When the queue is empty at the
block snapshot, `try_consume().none_if_missing()` yields `None` and the
transaction writes **no storage delta at all**.  It cannot conflict with
anything -- probes confirm it commits alongside concurrent inserts, and
alongside other degenerate cranks.  It is terminal: it will not be retried.

**There is no "the queue drained out from under me" case.** Snapshot isolation
means a second cranker in a block sees the same non-empty queue as the first and
tries to consume the same entries.  It is excluded and retried; it does not
observe an empty queue.  So a crank has exactly two outcomes: it does work, or
it is deferred to a later block.

**Same-block cranking works, when the ordering cooperates.** A crank landing
after a request in the same block does pick it up (the queue's retro-causal
`observed_concurrent_entries`).  A crank ordered before it sees nothing and
no-ops.  Which one happens is the proposer's choice, so same-block service is a
bonus, not a guarantee.

**The queue has no length.** `RCQ` exposes only `insert`, `peek`, and `consume`.
A length must be maintained separately.

**Counter reads are block-stale.** `NNInt::get` returns the last committed value
plus the reading transaction's own deltas -- never a concurrent transaction's.
(This is why `Driver::request` mixes the transaction hash into the request id:
concurrent enqueues in a block all read the same `seq`.)  Any length published
at enqueue time is identical for every request in that block and blind to that
block's own arrivals.

**Gas is free, but the declared limit is the scheduling quantity.** No tokens are
burned for execution.  However, a root transaction's declared gas limit is the
amount of HOG throughput capacity the scheduler accounts for, spent whether or
not execution uses it, with no refund.  Over-declaring a crank's gas limit costs
the caller real throughput share under congestion.  This is the actual price of
cranking, and it is proportional to the batch you declare -- not to the batch you
get.

## The consequence: ripeness thresholds are counterproductive

The strawman gated processing on a ripe queue (length over `QUEUE_RIPE_LEN`, or
oldest request older than `REQUEST_RIPE_AGE`).  Given the facts above, this costs
latency and buys no bandwidth.

Suppose requests arrive at 3 per block and one crank can handle 10:

* *Always drain*: one crank per block moves 3.  Throughput 3/block, latency
  ~1--2 blocks.
* *`QUEUE_RIPE_LEN = 10`*: the queue builds for ~3 blocks, then one crank moves
  10.  Throughput 10/3 ~= 3.3/block -- the same, because it is arrival-limited --
  and latency is now ~3--4 blocks.

A threshold pays off only when a crank carries a large *fixed* cost independent
of its batch size.  Under the adaptive drain below it does not: the cost is the
declared gas limit, which scales with the intended batch.

The batching the application wants happens by itself.  Because cranks are
limited to one per block, any arrival rate above one-crank-per-block builds a
queue automatically.  Batching is a consequence of the consumer rule, not
something policy has to manufacture; deliberately withholding a drain only adds
latency to a batch that the next block's crank would have taken anyway.

Dropping ripeness also removes the need to stamp a block height into each entry
and to `peek` before draining.

## Proposal

Four changes to the contracts, and one client-side policy.  None of them
requires a designated cranker, an off-chain schedule, or an estimate of queue
state.

### 1. Drain to the caller's gas limit

`batch_driver::process` currently stops at a fixed high-water mark of about ten
requests' worth of gas, which forces every caller to declare the matching
`PROCESS_REQUESTS_GAS` (10_000 + 10 x 600_000 ~= 6M) whether or not it wants a
batch that large.  Replace the fixed mark with the frame's actual remaining gas:

```rust
pub fn process<R, F, E>(queue: &mut RCQ<R>, mut handle: F) -> (u32, u32) {
    let mut n_processed = 0;
    let mut n_failed = 0;

    // Consume only while the frame can still fund a whole request plus this
    // loop's own epilogue.  The check must precede `try_consume`: a consumed
    // entry cannot be put back.  `R::GAS_LIMIT` is the static upper bound over
    // request kinds -- knowing the next request's exact cost would take a peek.
    while gas_remaining() > R::GAS_LIMIT + EPILOGUE_GAS {
        let Some(request) = queue.try_consume().none_if_missing() else {
            break;
        };
        ...
    }

    (n_processed, n_failed)
}
```

The caller's declared gas limit now *is* its chosen batch size, honestly priced:
a latency-sensitive user can crank two requests cheaply, a keeper can drain
deeply, and neither over-encumbers.  The fixed `PROCESS_REQUESTS_GAS` gives way
to `batch_driver::gas_for_batch::<R>(batch_size)`, and the driver's
`process_requests_gas(batch_size)` naming it, so a caller asks for the batch it
wants rather than reading off a figure chosen for it.  The reserve that check
needs -- one request's worth beyond the batch, since the loop must find room for
a whole request before taking one -- stays inside the helper.

`process_requests` keeps its current signature: an explicit `max_requests`
argument would only restate what the declared gas limit already says.

This is the piece most worth copying into other batching applications, and it
belongs in the reusable helper rather than in `swap-driver`.

### 2. Keep the crank a standalone transaction

Do not offer a combined submit-and-crank entry point.  Two reasons, both
structural:

* A crank ordered before its own request in the block cannot see it (snapshot
  isolation), so the combination does not shorten the request's own latency in
  the general case.
* If the combined transaction loses the crank race, it is excluded *entirely* --
  taking the request submission down with it, and delaying exactly the request
  the user was trying to accelerate.

Separation also keeps the crank's declared gas limit -- the throughput
encumbrance -- independent of the request's.

### 3. Bound the queue with a slot counter, on the producer side

The consumer needs no admission control; it is already limited to one per block.
What is missing is the administrator's storage bound.  Add a remaining-capacity
counter to the driver:

```rust
#[storage]
pub struct Driver {
    cfg: Value<Cfg>,
    requests: RCQ<SwapRequest>,
    seq: NNInt,
    slots: Node<Slots>, // remaining queue capacity
}
```

* `initialize(handler, max_queue_len)`: `self.slots.set_capacity(max_queue_len)`
* `request`: `self.slots.reserve()`
* `process_requests`: `self.slots.release(n_processed)` (failed requests were
  consumed too, so they return their room)

The cap is a parameter rather than a constant because it is a funding decision:
the deposit comes out of the driver contract's own balance, so whoever deploys
and funds a driver should size it.  The factory passes its own default.
`batch_driver::Slots` holds the counter, so the lazy-versus-strict choice below
is made once, where the pattern is documented, rather than at each driver.

Concurrent enqueues merge as deltas and never conflict with each other.  When the
queue is full, the aggregate would breach the floor and the surplus enqueues are
excluded and returned to the mempool -- they land as soon as a drain frees
capacity.  Backpressure is graceful and the storage bound is exact:
`MAX_QUEUE_LEN x rcq_cost_per_entry`, which is what the administrator funds.

Use the lazy `inc`, **not** `strict_inc`.  `strict_inc` checks against the
snapshot base, so when the queue is already full at the snapshot it reverts the
root frame: the transaction lands in the block with no effect and is never
retried.  The lazy form defers the bound to reservation, so an early request is
merely deferred.  Probes confirm both behaviours (`ExecResult(3)` versus
`ExecResult(2)`).

Note that the contract's HOG balance already provides a crude version of this --
a storage write beyond the contract's free balance fails reservation the same way
-- but a stated cap is clearer, and it leaves the contract's balance free for its
other storage.

### 4. Report batches, not queue depth

Do not add queue length or request age to `RequestAccepted`: it would be
block-stale, identical for every request in the block, and blind to that block's
own arrivals.  Instead emit a batch summary from the crank:

```rust
#[derive(Event, ...)]
pub struct RequestsProcessed {
    pub processed: u32,
    pub failed: u32,
}
```

A client wanting a queue estimate takes the `RequestAccepted`s it has seen, less
the `processed` these report.  That is both fresher than any on-chain read and
free of storage and conflict cost.

A crank that processed nothing emits no event: it has no work to describe, and
staying silent keeps a crank that found an empty queue exactly as free as the
runtime already makes it.  The caller loses nothing either way -- it gets the
same counts as `process_requests`' return value -- so the event is for observers
that see only the event stream.

### 5. Client policy: fire and forget

After submitting a request, submit a crank as its own transaction, with:

* a gas limit sized to the batch the user is willing to fund (see 1), and
* a short `block_expiry_height` -- a few blocks -- so that a crank which keeps
  losing does not linger and land much later as a no-op.

Then stop.  There is nothing to poll, no block height to track, no ripeness to
estimate, and no need to dead-reckon against average inter-block time.  If
another party's crank wins the block, this one is deferred by the mempool and
lands in a later one; if the queue was empty at the snapshot, it commits as a
free no-op.

A committed crank returning `(0, 0)` is a normal outcome, not an error and not
proof that the queue was drained -- the app already assumes this ("A successful
crank transaction does not prove that every locally tracked request reached a
terminal state", 2026-08-14-swap-multi-request).  A user whose request is still
queued simply submits another crank.

### Liveness

An administrator's keeper cranking every block gives ~1-block latency.  User
cranks then simply lose and defer, harmlessly.  If the keeper stops, user cranks
begin winning in the very next block.  The two paths compose without a mode
switch and without anyone having to detect that the keeper is down -- which is
the property that makes this worth imitating.

The administrator is not obliged to run one: the scheme is complete without it.
It just moves the expected latency from "whenever some user cares enough" to
"next block".

## Considered and rejected

**Ripeness thresholds** (`QUEUE_RIPE_LEN`, `REQUEST_RIPE_AGE`).  Cost latency,
buy no bandwidth, and make collisions *more* likely by turning ripeness into
common knowledge -- every interested user becomes eligible in the same block.
See the analysis above.

**Publishing queue depth at enqueue.**  Stale by construction; the event stream
gives clients a better estimate for free.

**Combined submit-and-crank.**  See 2.

**Paying the cranker** (per-request bounty, or a cranker's share of the swap
fee).  Since execution is free, the only cost of cranking is the caller's
throughput encumbrance, which is small and already borne by the party who cares
most about latency.  A bounty would add an escrow transfer, storage, and gas to
every request in exchange for an incentive the fee model does not require.  Worth
revisiting only if free-riding turns out to leave queues sitting.

**Using `CapacityConstraint` to admit one crank per block.**  Redundant: the RCQ
already permits exactly one consumer per block, with the mempool-retry behaviour
we want.  `CapacityConstraint` remains the right tool if a per-block *arrival
rate* cap is ever wanted on the producer side; the standing length cap in 3 is a
plain counter because it persists across blocks.

## Expected behaviour

* **Latency.**  A request enqueued in block N is served by the first crank that
  lands from block N onward -- block N itself if the proposer orders a crank
  after it, otherwise N+1, and later only if cranks keep losing to each other.
  With a keeper, effectively N or N+1.
* **Bandwidth.**  One crank per block, as large as its declared gas limit allows.
  This is the platform maximum for a single pair; no policy can exceed it.
* **Administrator exposure.**  Storage bounded at `MAX_QUEUE_LEN` entries.  No
  throughput obligation at all unless the administrator chooses to run a keeper.
* **Degenerate cranks.**  Free at the protocol level (no deltas, no conflict).
  They cost the sender its declared throughput encumbrance, which is the correct
  and sufficient disincentive against spamming large ones.

## Follow-ups

* Calibrate `EPILOGUE_GAS` against the guest build, alongside the existing
  empirical `*_GAS` constants in `swap-if`.
* Choose `MAX_QUEUE_LEN`, and check it against the driver contract's funded HOG
  balance and `rcq_cost_per_entry`.

### For the swap app

What the contract changes above mean for [`apps/swap`](apps/swap/), for whoever
picks the app up once the contract side settles.  Nothing here is urgent while
the contracts are still moving.

* **Regenerate the bindings.**
  [`apps/swap/src/contracts/generated/swap-driver.ts`](apps/swap/src/contracts/generated/swap-driver.ts)
  no longer matches the driver's spec.  `generate-contract-bindings.sh` needs
  CLI 0.9.6 or newer; 0.9.0 emits an older binding shape and will rewrite the
  whole file if used.  Nothing is broken meanwhile: entrypoint ids derive from
  the method name alone, so the ids in the checked-in file -- and
  `SWAP_DRIVER_PROCESS_REQUESTS_ENTRYPOINT` in the generated `.env.local` --
  are still correct.

* **`SwapDriver::initialize` takes a `max_queue_len: u32`.**  A bindings-only
  change for the app, which never calls it: the factory initializes each
  driver on-chain when it creates the pool.

* **New event: `RequestsProcessed { processed: u32, failed: u32 }`.**  Emitted
  once per batch that took anything, and attributed (like every event) to the
  driver's own address, which is what distinguishes one pair's batches from
  another's.  A crank receipt carrying it says in one place what the crank did,
  rather than requiring a tally of the terminal events in it.  A crank that
  found the queue empty emits nothing.

* **The crank's declared gas limit now chooses the batch size.**  `TARGET_GAS`
  in [`src/contracts/driver-target.ts`](apps/swap/src/contracts/driver-target.ts)
  (10M) used to be a safe over-declaration against a fixed ceiling of about ten
  requests; it now selects the batch -- about sixteen, if every request costs
  the full `REQUEST_GAS_MAX`, and more when they cost less.  Since the declared
  limit is also the throughput capacity the scheduler charges under congestion,
  it is now worth choosing deliberately: small for a user cranking to hurry its
  own request along, large for draining a backlog.  The Rust-side sizing helper
  is `swap_driver::process_requests_gas(batch_size)`.

* **A request submission can now be *deferred*.**  With the queue at its
  ceiling, a `request` transaction is excluded from its block and returned to
  the mempool rather than failing, so it may land a block or more later, or
  expire unfulfilled.  Before assuming the existing committed/failed split in
  `outcomeFromReceipt` covers this, confirm against a devnode how an excluded
  transaction surfaces through the RPC status API: it is in no block at all, so
  it ought to read as not-yet-observed rather than as a committed failure --
  but that is worth seeing rather than assuming.  A submission's expiry height
  is what bounds the wait.

* **A committed crank returning `(0, 0)` is ordinary**, not an error: it means
  the queue was empty at that block's snapshot, or another crank got there
  first.  The app's existing rule that a successful crank does not prove any
  particular request reached a terminal state (see
  [2026-08-14-swap-multi-request](docs/specs/2026-08-14-swap-multi-request.md))
  already covers it.

## Established

The queue semantics this design rests on are pinned down by
[`helpers/batch-driver/tests/queue_semantics.rs`](helpers/batch-driver/tests/queue_semantics.rs):
one consumer per block, a losing crank deferred to the mempool having seen the
undrained snapshot, a crank on an empty queue as a delta-free no-op that
conflicts with nothing, and same-block service when the proposer's ordering
allows it.

The summary event is pinned down by
[`contracts/swap-driver/tests/batch_summary.rs`](contracts/swap-driver/tests/batch_summary.rs):
a batch counts failed requests as processed, a successful batch reports no
failures, and an empty batch emits nothing at all.

The admission behaviour is pinned down by
[`helpers/batch-driver/tests/admission.rs`](helpers/batch-driver/tests/admission.rs)
and [`contracts/swap-driver/tests/admission.rs`](contracts/swap-driver/tests/admission.rs):
concurrent enqueues within the ceiling all land, the one that overruns it runs
its frame to completion and is held back only at commit (so the mempool retries
it), and draining returns the room -- including the room of requests whose
handling failed.
