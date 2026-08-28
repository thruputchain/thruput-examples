# Swap Contracts

The `swap-*` contracts are an example port (not for production) from Ethereum to
Groundhog of UniswapV2, adding a request-batching layer:

- [`swap-if`](../interfaces/swap-if/): Interface-only crate.  It defines every swap contract's trait,
  client, and error type, plus the shared value types (including the
  `SwapRequest` request types), so the contracts can call one another -- and be
  created by the factory -- without depending on each other's implementations.
- `swap-pair`: Fundamental operations (cf. [UniswapV2Pair]).
- `swap-handler`: Executes high-level swap-operation requests. When a request
  is serviced (not when it is submitted), it performs price-optimizing
  calculations, transfers assets in from users, and calls the primitives in
  `swap-pair`.
- `swap-driver`: A request-processing driver that batches requests and forwards
  each to its handler, all in the same block. Generic parts of this pattern are
  provided by [`helpers/batch-driver`](../helpers/batch-driver/src/lib.rs),
  whose module docs cover the pattern in general.
- `swap-factory`: Creates new pairs and keeps a registry of them.
- `swap-router`: High-level facilities similar to those in [UniswapV2Router02];
  it builds `SwapRequest` values and enqueues them with the driver for the
  appropriate swap-pair.

## Why a Request Queue

The pair's fundamental operations must happen serially: each one reads the
reserves, computes against them, and writes them back, so two swaps on a pair
cannot execute concurrently.

If each swap operation were serviced upon request, it would need a block of its
own, which would cap a pair at one operation per block for the whole network.
The queue is what lifts that cap. Requests are *enqueued* concurrently (an
`RCQ`'s inserts commute, so any number of them may be accepted together) and
are later handled in a batch, all inside one transaction. The semantics of the
fundamental pair operations are preserved, as they occur serially as intended.

So the ceiling on a pair's throughput is not one operation per block, but how
many operations it can execute in one transaction; the queue's job is to keep
that transaction well-fed.

## Request Lifecycle

Users of the swap application submit requests to the router, which it forwards
to the driver associated with the indicated token-pair. The driver emits a
`RequestAccepted` event and provides a request ID that is returned to the user.

In a later transaction, an external call to `SwapDriver::process_requests()`
forwards queued requests to the handler. A successful pair operation includes
the request ID in its associated event; for a failed operation, the driver
includes the id in a `RequestFailed` event.

A driver's queue holds a bounded number of requests at once. A request arriving
at a full queue is not rejected: its transaction is excluded from the block and
returned to the mempool, and is admitted once processing has made room. It
stops waiting at its own expiry height, leaving its sender free to resubmit
against a fresh quote.

The cap on the queue length bounds the amount of storage required of the
driver, but more importantly also bounds how long an admitted request might
wait, which matters because admission is irrevocable: a queued request cannot
be withdrawn, and executes against whatever reserves obtain when it is finally
handled, however stale the quote has become that its slippage limits were
chosen against. Eventually, being turned away is the better outcome, so the
ceiling is set to tolerable backlog.

## Cranking the Queue

Forwarding queued requests to the handler — "cranking the queue" — is an
ordinary call to `process_requests()`, in a transaction of its own, by anyone.
It needs no privilege and no coordination.

The crank drains requests until the queue empties or the transaction's gas
limit runs out, so **the caller's declared gas limit is the batch size**
(`swap_driver::process_requests_gas(batch_size)` computes it). Execution costs
no fees, but a root transaction's declared limit is the throughput capacity the
scheduler charges against the caller's free HOG, spent whether or not the batch
fills it — so a user cranking to hurry its own request along asks for a small
batch, and one draining a backlog asks for a large one.

One limit on that freedom: a crank must be able to drain whatever is waiting,
up to the pool's `min_crank_batch`, or it is refused with
`SwapDriverError::BatchTooSmall`. Only one crank per block can land, so without
a floor the cheapest way to hold that slot would be a crank funded for a single
request — a fraction of a full crank's cost, displacing one, and leaving the
queue moving one request per block for as long as anyone cared to keep it up.
Owing what is waiting makes holding the slot cost about what clearing the queue
costs.

That figure is set when the pool is created, alongside the queue's ceiling,
because the two trade off against each other and against how a pair is used —
see `MIN_CRANK_BATCH` in
[`swap-factory`](../contracts/swap-factory/src/factory.rs) for how to choose it.

The cap matters as much as the floor, and so does tying the requirement to the
backlog rather than switching it on at some depth. A cap keeps cranking within
reach when a queue is long, which is when it most needs draining. Tying it to
the backlog leaves no shallow depth an attacker can park the queue at: a crank
facing one waiting request owes one request's worth, and a user hurrying its own
lone request still cranks for almost nothing.

The recommended policy for a client is to send a crank after its request, with
a short expiry height, and then stop. There is nothing to poll and no queue
depth to estimate, because each outcome is already harmless:

- **Another crank won the block.** Only one transaction per block may drain a
  given queue; the others are excluded and returned to the mempool, and land in
  later blocks on their own.
- **The queue was empty at the block's snapshot.** The crank commits having
  done nothing, writing no storage delta and conflicting with nobody. (A `(0,
  0)` result from `process_requests` is ordinary, and does not mean any
  particular request has been handled.)
- **Otherwise it drains**, emitting one `RequestsProcessed` event that
  summarizes the outcome of the batch.

The short expiry keeps the first case from becoming a nuisance: a crank that
loses several blocks running should expire rather than land much later as a
pointless no-op.

Combining a crank with a request submission would delay the request rather than
hurry it: a crank cannot see requests its own block ordered after it, and a
combined transaction that loses the race is excluded whole. See the
[`batch-driver`](../helpers/batch-driver/src/lib.rs) module docs.

### Why the driver does not hold out for a bigger batch

A driver could refuse to drain until the queue reached some depth, on the
theory that fuller batches use a block better. It would not. Only one crank per
block can land, so a queue already builds by itself whenever requests arrive
faster than one crank drains them — batching is a consequence of that rule, not
something a policy has to arrange. Holding a drain back only adds latency to a
batch the next block would have taken anyway.

Concretely: if requests arrive three to a block and a crank can handle ten,
draining every block moves three per block, a block or two after each arrives.
Holding out for ten builds up the queue for three blocks and then handles the
ten requests: the same throughput, since it was arrival-limited all along, but
at three or four blocks of latency instead. A depth threshold would only pay
for itself if a crank carried a large fixed cost independent of its batch size,
and it does not: the hog-allocation cost is the declared gas limit, which
scales with the batch asked for.

### Nobody has to be on duty

Cranking is permissionless and the administrator carries no standing
obligation: a pool works if its users crank for themselves, and needs no HOG
from its operator beyond the storage its contracts hold.

An operator wanting better latency can run a keeper that cranks every block.
The two compose without a mode switch: while the keeper runs, it wins each
block and users' cranks defer harmlessly behind it; if it stops, theirs start
winning the very next block. Nothing has to detect which is happening.

## Trust and Permissions

An operation reaches the reserves along one path:

```
router  ->  driver  ->  handler  ->  the pair's code
```

The router is the public entry point and the only contract that sees the user
directly, so it is where the operation's payer is recorded. Every stage below it
carries that identity along as *data* — a `SwapRequest` names the account whose
tokens it will spend, and the handler spends them on that account's standing
allowance to it.

That makes each stage's willingness to be called a security property, because
nothing downstream can check the claim the data makes. So each link takes work
from its predecessor alone: `SwapDriver::request` admits only the router, and
`SwapHandler::handle_request` only that pool's driver. Both refuse anyone else
with an `Unauthorized` error. Without those, anyone could enqueue a request
naming a victim as the payer and themselves as the recipient, and be paid out of
the victim's approval.

The pair needs no such guard, because it is no longer a contract: its operations
run inside the handler's own invocation, so there is no entry point to defend.
That is the security dividend of collapsing it — a boundary that cannot be
called wrongly beats one that is checked correctly.

### What is deliberately open

- **`process_requests`**, so that cranking stays permissionless. The queue is
  the pool's throughput, and making it depend on a privileged keeper would
  defeat the point; see [Cranking the Queue](#cranking-the-queue).
- **`skim` and `sync`**, as in UniswapV2. They attribute nothing and can only
  move what the reserves do not already account for, so they remain available
  for recovering tokens sent to a pool by mistake.

### Initialization

None of the `initialize` methods checks its caller, and none can: before the
first call there is no principal to check against, and any address passed in for
comparison would be supplied by the very caller being checked.

What protects them instead is that a pool is deployed *and* initialized inside a
single transaction — `SwapFactory::create_pair` deploys the LP token, handler
and driver, then wires them together before it returns — so nothing can act on
those contracts in between. A second call is refused. And a deployed address
derives from its deployer, so no one else can deploy to the address the factory
predicted for a pool.

The one ordering this imposes reaches outside the factory: each driver is told
the router whose requests it will accept, so the factory must be told the router
too, at its own initialization. The router therefore has to be *deployed* —
though not yet initialized — before `SwapFactory::initialize` is called.

## Frontend

See [`apps/swap/README.md`](../apps/swap/README.md) for a web-based interface
to the swap application.

[UniswapV2Pair]: https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
[UniswapV2Router02]: https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
