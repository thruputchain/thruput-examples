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
  forwards each to its handler, all in the same block.
- `swap-factory`: Creates new pairs and keeps a registry of them.
- `swap-router`: High-level facilities similar to those in [UniswapV2Router02];
  it builds `SwapRequest` values and enqueues them with the driver.

## Request Lifecycle

The router returns a request ID when the driver accepts a request. The driver emits `RequestAccepted`, then an external call to `process_requests()` forwards queued requests to the handler. Successful pair operations include the request ID in their event; failed processing emits `RequestFailed` from the driver. This lets clients distinguish enqueueing from terminal execution.

A driver holds at most `max_queue_len` requests at once, since each one waiting costs a storage deposit locked out of the driver's own HOG balance. A request arriving at a full queue is not rejected: its transaction is excluded from the block and returned to the mempool, so it lands once a crank has made room.

## Cranking the Queue

Forwarding queued requests to the handler — "cranking the queue" — is an ordinary call to `process_requests()`, in a transaction of its own, by anyone. It needs no privilege and no coordination.

The crank drains until the queue empties or its gas limit runs out, so **the caller's declared gas limit is the batch size** (`swap_driver::process_requests_gas(batch_size)` computes it). Execution costs no fees, but a root transaction's declared limit is the throughput capacity the scheduler charges against the caller's free HOG, spent whether or not the batch fills it — so a user cranking to hurry its own request along asks for a small batch, and one draining a backlog asks for a large one.

The policy for a client is to send a crank after its request, with a short expiry height, and then stop. There is nothing to poll and no queue depth to estimate, because each outcome is already harmless:

- **Another crank won the block.** Only one transaction per block may drain a given queue; the others are excluded and returned to the mempool, and land in later blocks on their own.
- **The queue was empty at the block's snapshot.** The crank commits having done nothing, writing no storage delta and conflicting with nobody. A `(0, 0)` result is ordinary, and does not mean any particular request has been handled.
- **Otherwise it drains**, emitting one `RequestsProcessed` summarizing the batch.

The short expiry keeps the first case from becoming a nuisance: a crank that loses several blocks running should expire rather than land much later as a pointless no-op.

Combining a crank with a request submission would delay the request rather than hurry it — a crank cannot see requests its own block ordered after it, and a combined transaction that loses the race is excluded whole. See the [`batch-driver`](../helpers/batch-driver/src/lib.rs) module docs.

## Local Frontend

See [`apps/swap/README.md`](../apps/swap/README.md) for local node setup, the browser application, queue processing, tests, and troubleshooting.

[UniswapV2Pair]: https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
[UniswapV2Router02]: https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol
