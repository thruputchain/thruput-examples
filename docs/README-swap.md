# Swap Contracts

The `swap-*` contracts are an example port (not for production) from Ethereum to
Groundhog of UniswapV2, adding a request-batching layer:

- `swap-if`: Interface-only crate.  It defines every swap contract's trait,
  client, and error type, plus the shared value types (including the
  `SwapRequest` request types), so the contracts can call one another -- and be
  created by the factory -- without depending on each other's implementations.
- `swap-pair`: Fundamental operations (cf. [UniswapV2Pair]).
- `swap-handler`: Executes high-level swap-operation requests.  (It performs the
  price-optimizing calculations against the reserves when a request is serviced,
  not when it is submitted.)
- `swap-driver`: An abstract request-processing driver that batches requests and
  forwards each to its handler, all in the same block.  The parts of that which
  are not specific to swapping -- the drain loop and its gas budgeting, and the
  ceiling on the queue -- live in
  [`helpers/batch-driver`](../helpers/batch-driver/src/lib.rs), whose module
  docs cover the pattern in general.
- `swap-factory`: Creates new pairs and keeps a registry of them.
- `swap-router`: High-level facilities similar to those in [UniswapV2Router02];
  it builds `SwapRequest` values and enqueues them with the driver.

## Why a Request Queue

The pair's fundamental operations must happen serially: each one reads the
reserves, computes against them, and writes them back, so two swaps on a pair
cannot be in flight at once.  On Groundhog that is not a lock but a conflict --
`swap-pair` keeps its reserves in a `Value<Reserves>`, and two transactions
reading and rewriting it in one block cannot both land.

Left at that, each swap would need a block of its own, which would cap a pair at
one operation per block for the whole network.  The queue is what lifts that cap.
Requests are *enqueued* concurrently -- an `RCQ`'s inserts commute, so any number
of them land together -- and are later handled in a batch, all inside one
transaction, which the pair is perfectly happy with because that transaction
touches the reserves serially within itself.

So the ceiling on a pair's throughput is not one operation per block but
**whatever one transaction can do**, and the queue's job is to keep that
transaction well fed.

## Request Lifecycle

The router returns a request ID when the driver accepts a request. The driver emits `RequestAccepted`, then an external call to `process_requests()` forwards queued requests to the handler. Successful pair operations include the request ID in their event; failed processing emits `RequestFailed` from the driver. This lets clients distinguish enqueueing from terminal execution.

A driver holds at most `max_queue_len` requests at once. A request arriving at a full queue is not rejected: its transaction is excluded from the block and returned to the mempool, so it lands once a crank has made room — and if none ever does, it expires at its own expiry height, leaving its sender free to resubmit against a fresh quote.

That ceiling is not a storage budget. A queued entry's deposit is flat and small, so a driver funded the way `apps/swap` funds one could hold a queue of millions. What the ceiling bounds is how long an admitted request might wait, which matters because admission is irrevocable: a queued request cannot be withdrawn, and executes against whatever reserves obtain when it is finally handled, however stale the quote its slippage limits were chosen against. Being turned away is the better outcome, so the ceiling is set to a backlog still worth joining. The reasoning and the measured figures are on `MAX_QUEUE_LEN` in [`swap-factory`](../contracts/swap-factory/src/factory.rs).

## Cranking the Queue

Forwarding queued requests to the handler — "cranking the queue" — is an ordinary call to `process_requests()`, in a transaction of its own, by anyone. It needs no privilege and no coordination.

The crank drains until the queue empties or its gas limit runs out, so **the caller's declared gas limit is the batch size** (`swap_driver::process_requests_gas(batch_size)` computes it). Execution costs no fees, but a root transaction's declared limit is the throughput capacity the scheduler charges against the caller's free HOG, spent whether or not the batch fills it — so a user cranking to hurry its own request along asks for a small batch, and one draining a backlog asks for a large one.

The policy for a client is to send a crank after its request, with a short expiry height, and then stop. There is nothing to poll and no queue depth to estimate, because each outcome is already harmless:

- **Another crank won the block.** Only one transaction per block may drain a given queue; the others are excluded and returned to the mempool, and land in later blocks on their own.
- **The queue was empty at the block's snapshot.** The crank commits having done nothing, writing no storage delta and conflicting with nobody. A `(0, 0)` result is ordinary, and does not mean any particular request has been handled.
- **Otherwise it drains**, emitting one `RequestsProcessed` summarizing the batch.

The short expiry keeps the first case from becoming a nuisance: a crank that loses several blocks running should expire rather than land much later as a pointless no-op.

Combining a crank with a request submission would delay the request rather than hurry it — a crank cannot see requests its own block ordered after it, and a combined transaction that loses the race is excluded whole. See the [`batch-driver`](../helpers/batch-driver/src/lib.rs) module docs.

### Why the driver does not hold out for a bigger batch

A driver could refuse to drain until the queue reached some depth, on the theory that fuller batches use a block better. It would not. Only one crank per block can land, so a queue already builds by itself whenever requests arrive faster than one crank drains them — batching is a consequence of that rule, not something a policy has to arrange. Holding a drain back only adds latency to a batch the next block would have taken anyway.

Concretely: if requests arrive three to a block and a crank can handle ten, draining every block moves three per block, a block or two after each arrives. Holding out for ten builds for three blocks and then moves ten — the same throughput, since it was arrival-limited all along, at three or four blocks of latency instead. A depth threshold would only pay for itself if a crank carried a large fixed cost independent of its batch size, and it does not: the cost is the declared gas limit, which scales with the batch asked for.

It would also make collisions likelier rather than rarer, by turning "the queue is ripe" into common knowledge that makes every interested user eligible in the same block.

### Nobody has to be on duty

Cranking is permissionless and the administrator carries no standing obligation: a pool works if its users crank for themselves, and needs no HOG from its operator beyond the storage its contracts hold.

An operator wanting better latency can run a keeper that cranks every block. The two compose without a mode switch: while the keeper runs it wins each block and users' cranks defer harmlessly behind it, and if it stops, theirs start winning the very next block. Nothing has to detect which is happening.

Either way, a request enqueued in block N is served by the first crank to land from block N onward — block N itself if the proposer happens to order a crank after it, otherwise N+1, and later only if cranks keep losing to one another.

## Local Frontend

See [`apps/swap/README.md`](../apps/swap/README.md) for local node setup, the browser application, queue processing, tests, and troubleshooting.

The app has not yet been updated for the cranking changes described above; [`APP-CHANGES.md`](../APP-CHANGES.md) lists what that involves.

[UniswapV2Pair]: https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
[UniswapV2Router02]: https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
