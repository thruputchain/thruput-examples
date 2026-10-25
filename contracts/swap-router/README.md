# Swap Contracts

The `swap-*` contracts are an example port (not for production) from Ethereum to
Thruput of UniswapV2, adding a request-batching layer:

- [`swap-if`](../../interfaces/swap-if/): Interface-only crate.  It defines every swap contract's trait,
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
   provided by [`helpers/batch-driver`](../../helpers/batch-driver/src/lib.rs),
  whose module docs cover the pattern in general.
- `swap-gsr-driver` and `swap-clvr-driver`: Drop-in alternatives to
  `swap-driver` that hand requests to the handler in an order chosen to protect
  traders, by the GSR and CLVR rules; see
  [Ordering a Batch](#ordering-a-batch-gsr-and-clvr).
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

`RequestFailed` also reports the failure cause: exception, fault, rejected call,
or malformed result. For exceptions it includes the selector and up to 256 bytes
of payload; `payload_len` records the original length so truncation is explicit.
These diagnostics do not change the request's terminal failed status.

A driver's queue holds a bounded number of requests at once. A request arriving
at a full queue is not rejected by the contract: its transaction fails at commit
and is left out of the block with nothing written. The network reports it as
one to retry but does not retry it itself; its sender can submit the same
signed transaction again once processing has made room, or decide against it.

The cap on the queue length bounds the amount of storage required of the
driver, but more importantly also bounds how long an admitted request might
wait, which matters because admission is irrevocable: a queued request cannot
be withdrawn, and executes against whatever reserves obtain when it is finally
handled, however stale the quote has become that its slippage limits were
chosen against. Eventually, being turned away is the better outcome, so the
ceiling is set to tolerable backlog.

What a request's sender *can* do is starve it. The handler spends the sender's
standing allowance when the request is handled, so revoking that allowance (or
moving the tokens away) makes the request fail then -- in isolation, since each
request is handled under commit-locking: the crank, and every other request in
its batch, go through as before, and the starved one is reported by a
`RequestFailed` event. This holds even when the revocation lands in the same
block as the crank, whichever of the two the block orders first; see
`swap-driver/tests/same_block.rs`.

## Cranking the Queue

Forwarding queued requests to the handler — "cranking the queue" — is an
ordinary call to `process_requests()`, in a transaction of its own, by anyone.
It needs no privilege and no coordination.

The crank drains requests until the queue empties or the transaction's gas
limit runs out, so **the caller's declared gas limit is the batch size**
(`swap_driver::process_requests_gas(batch_size)` computes it). Execution costs
no fees, but a root transaction's declared limit is the throughput capacity the
scheduler charges against the caller's free native tokens, spent whether or not the batch
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
[`swap-factory`](../swap-factory/src/factory.rs) for how to choose it.

The cap matters as much as the floor, and so does tying the requirement to the
backlog rather than switching it on at some depth. A cap keeps cranking within
reach when a queue is long, which is when it most needs draining. Tying it to
the backlog leaves no shallow depth an attacker can park the queue at: a crank
facing one waiting request owes one request's worth, and a user hurrying its own
lone request still cranks for almost nothing.

The recommended policy for a client is to send a crank once its request has
committed, and to send another if the request is still waiting once that crank
has landed. There is no queue depth to estimate, because each outcome is
harmless:

- **Another crank claimed the block first.** Only one crank per block drains a
  given queue: each first claims the drain with a commit-locked call to the
  handler, and only the first claim can hold. The others commit having done
  nothing.
- **There was nothing to drain.** The crank commits having done nothing,
  writing no storage delta and conflicting with nobody. (A `(0, 0)` result from
  `process_requests` is ordinary, and does not mean any particular request has
  been handled.)
- **Otherwise it drains**, emitting one `RequestsProcessed` event that
  summarizes the outcome of the batch.

Without the claim, the first case would not be harmless. Two cranks draining in
one block cannot both commit, but the loser's commit-locked calls to the
handler would have made the winner's own calls fail.

Combining a crank with a request submission would not hurry the request: a
crank cannot see requests its own block ordered after it. See the
[`batch-driver`](../../helpers/batch-driver/src/lib.rs) module docs.

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
and it does not: the native-token allocation cost is the declared gas limit, which
scales with the batch asked for.

### Nobody has to be on duty

Cranking is permissionless and the administrator carries no standing
obligation: a pool works if its users crank for themselves, and needs no native tokens
from its operator beyond the storage its contracts hold.

An operator wanting better latency can run a keeper that cranks every block.
The two compose without a mode switch: while the keeper runs, it claims each
block and users' cranks find nothing to do; if it stops, theirs start winning
the very next block. Nothing has to detect which is happening.

## Ordering a Batch: GSR and CLVR

`swap-driver` hands a batch to the handler in the order its queue yields it:
arrival order between blocks, but within a block just the order of the
entries' bytes. Every trade moves the price the next one sees, so that order
decides who trades at what price, and it is arbitrary. Two alternative drivers
choose it by a rule instead. Both take the price p₀ the pool has when a crank
begins as their reference, both run liquidity operations first (they do not
move the price), and both make the order a function of the requests and the
reserves alone, so whoever cranks has no say in it.

With the price p = reserve1 / reserve0, a trade paying token0 in lowers it, and
a trade paying token1 in raises it.

### GSR: which side of p₀

[`swap-gsr-driver`](../swap-gsr-driver/src/gsr.rs) follows the Greedy
Sequencing Rule ([Ferreira and Parkes][GSR]): while the price is at or above
p₀, take a trade that lowers it; while it is below, one that raises it; when
one kind runs out, take the rest. Every trade then gets a price at least as
good as it would have alone at p₀, or a worse one from which whoever ordered it
gains nothing, so a sandwich does not pay.

The rule never compares two trades of the same kind, so it needs no sorting.
The driver's queue is a `batch_driver::LanedQueue`: each request is put in a
lane for the way it moves the price when it is enqueued, each lane keeps queue
order, and the crank takes the head of whichever lane the rule picks, reading
the pool's price after each request that succeeds. It streams, as a plain
crank does, so the caller's gas limit sizes the batch exactly as for
`swap-driver`. The lanes share the queue's one ceiling.

### CLVR: nearest p₀

[`swap-clvr-driver`](../swap-clvr-driver/src/clvr.rs) refines GSR with the CLVR
rule ([McLaughlin, Chemaya, Liu and Malkhi][CLVR]): of the trades not yet
placed, take the one that leaves the price *nearest* p₀ -- which may even be a
small trade away from p₀, when the only trade back toward it would overshoot.
That keeps the price's path through the batch closer to p₀, and undoes a
sandwich too: the attacker's two legs all but cancel, so whichever moves the
price first, the other is placed next.

The rule is greedy, and the paper's appendix makes each step cheap with **two
queues**, one per direction, each sorted by size. From above p₀, the smallest
price-raising trade is the best of its queue, and the best price-lowering one
sits either side of the size that would land on p₀, which a binary search
finds; from below, the roles swap. (Each queue keeps exact-in and exact-out
trades in separate sorted runs, since which of those two moves the price
further depends on the reserves at the time.) Slippage limits play no part in
the order: a trade its limit refuses changes nothing, and the next step starts
from the same price.

Choosing the nearest trade means seeing them all, so this driver uses
`batch_driver::Queue::crank_sequenced`: the batch is taken out of the queue up
front, as many requests as the caller's gas limit pays for at each one's worst
case plus the sequencer's share, and handed to a `batch_driver::Sequencer`. The
batch is still the first requests the queue yields -- CLVR only orders *within*
it -- so no request waits behind one admitted in a later block.

### Deploying either

Both implement the same `SwapDriver` interface as `swap-driver`, so a factory
deploys one in its place by being given its code hash in `SwapHashes::driver`.
Each request is still handled under commit-locking, in isolation, exactly once.
Their per-request gas allowances for choosing (`PICK_GAS`, `SEQUENCE_GAS`) are
placeholders until calibrated on a devnode.

[GSR]: https://arxiv.org/abs/2209.15569
[CLVR]: https://arxiv.org/abs/2408.02634

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

  Being open, they must also be harmless to the crank, which is a property of
  the concurrency model rather than of permissions. The reserves are one
  storage value, and two transactions that write it differently cannot share
  a block. A `sync` or `skim` that finds nothing to do therefore writes
  nothing at all -- not even to stamp the block -- so it cannot displace a
  crank, and costs an attacker's spam nothing but its own gas. One that does
  have something to record writes the reserves and takes its chances against
  the crank like any other writer; whichever loses fails at commit and is left
  out of the block, and if it is submitted again, the crank's own update has
  usually recorded the same balances by then, leaving it nothing to do. A
  consequence for oracle consumers: the cumulative prices advance only when the
  reserves change, so read them as of the pool's `block_timestamp` and
  extrapolate, as UniswapV2's oracle library does.

### Initialization

None of the `initialize` methods checks its caller, and none can: before the
first call there is no principal to check against, and any address passed in for
comparison would be supplied by the very caller being checked.

What protects them instead is that a pool is deployed *and* initialized inside a
single transaction — `SwapFactory::create_pair` funds, deploys and initializes
the LP token, handler and driver before it returns — so nothing can act on those
contracts in between. A second call is refused. And a deployed address
derives from its deployer, so no one else can deploy to the address the factory
predicted for a pool.

Funding is part of the same transaction. Each of the three contracts pays for
its own storage, so each must hold native tokens before it writes any; `create_pair` takes
a `funding` and moves that much to each address *before* deploying to it, which
deterministic deploy addresses make possible. The native tokens come from the caller, on
an allowance granted to the factory — out of the factory's own balance, anyone
could drain it by creating pools.

That the funding and the writes it pays for share a transaction is also why
`create_pair` cannot verify the funding was enough. A storage deposit is settled
when the transaction commits; a commit-locked (`try_`) initialization, which
would settle each contract's deposit as its call returned, weighs that contract
against the balance committed *before* this transaction — and so cannot see
funding paid within it. The factory checks a floor and no more — `pool_funding`
answers with that floor and the figure it recommends instead. Past the floor,
a shortfall is felt at the transaction's reservation, which leaves it out of the
block rather than including a failure there; submitted again, it fails the same
way.

Because creation spends the creator's native tokens, the router does not do it.
UniswapV2's router creates a pair on the first `addLiquidity`; ours resolves
every operation's pair against the factory's registry and throws
`SwapRouterError::NoSuchPair` if it is not there, leaving pool creation an
explicit call to the factory.

The one ordering this imposes reaches outside the factory: each driver is told
the router whose requests it will accept, so the factory must be told the router
too, at its own initialization. The router therefore has to be *deployed* —
though not yet initialized — before `SwapFactory::initialize` is called.

## Frontend

See [`apps/swap/README.md`](../../apps/swap/README.md) for a web-based interface
to the swap application.

[UniswapV2Pair]: https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
[UniswapV2Router02]: https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
