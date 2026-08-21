//! A request-batching driver for `swap_handler`.
//!
//! This is a thin, concrete shell around the reusable [`batch_driver`] core: it
//! owns the queue of [`SwapRequest`]s and supplies the one swap-specific piece
//! the core can't know -- how to forward a request to the handler contract.
//! The drain/gas/failure-accounting loop itself lives in `batch_driver::process`
//! and is shared by any driver, whatever its request type.

use crate::cfg::*;
use batch_driver::Slots;
use sdk::storage::*;
use sdk::*;
use swap_if::*;

/// State for the driver contract
#[storage]
pub struct Driver {
    // Configuration
    cfg: Value<Cfg>,

    // Requests (can be enqueued concurrently)
    requests: RCQ<SwapRequest>,

    // A monotonic sequence number, combined with the source-transaction hash to
    // mint each request's id.  Requests enqueued in one transaction share a tx
    // hash but get distinct sequence numbers, so their ids differ.
    //
    // An `NNInt`'s `inc` is a commutative, blind delta (like the `RCQ`, its
    // increments from concurrent transactions merge without conflict), so this
    // preserves the concurrent enqueue the queue is built for.
    seq: NNInt,

    // Room left in `requests`, counted down as requests arrive and back up as
    // they are drained.  This is what bounds the storage deposit the queue can
    // lock out of this contract's balance; see `batch_driver::Slots`.
    slots: Node<Slots>,
}

/// The gas limit to declare on a `process_requests()` call intended to drain
/// up to `batch_size` requests.
///
/// There is no one recommended figure: the drain is bounded by whatever gas
/// its frame has left, so the caller's declared limit *is* the batch size.  A
/// caller wanting low latency on its own request, and a small encumbrance of
/// its throughput share, asks for a small batch; one draining a backlog asks
/// for a large one.
pub const fn process_requests_gas(batch_size: u32) -> u64 {
    batch_driver::gas_for_batch::<SwapRequest>(batch_size)
}

#[contract(exports = "swap_driver_exports")]
impl SwapDriver for Driver {
    fn initialize(&mut self, handler: &Address, max_queue_len: u32) {
        if self.cfg.try_get().none_if_missing().is_some() {
            panic!("Already initialized.");
        }

        let cfg = Cfg { handler: *handler };

        // Ensure only one `initialize` call can succeed per block.
        self.cfg.set_exclusive(&cfg);

        self.slots.set_capacity(max_queue_len);
    }

    fn request(&mut self, request: SwapRequest) -> RequestId {
        // Claim this request's room in the queue.  If the queue is full the
        // claim overruns the capacity, and this whole transaction is excluded
        // from the block and returned to the mempool -- the request waits for
        // room rather than failing.
        self.slots.reserve();

        // Mint an id from the enqueuing transaction's hash plus a sequence
        // number: the tx hash lets the caller correlate the id with its
        // submission, while the sequence keeps requests distinct when several
        // are enqueued in one transaction (they share a tx hash but not a seq).
        self.seq.inc(1);
        let request_id = (get_source_transaction_hash(), self.seq.get()).hash();

        self.requests.insert(&request.with_request_id(request_id));

        log_event(&RequestAccepted::new(request_id));

        request_id
    }

    fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        let (n_processed, n_failed) =
            batch_driver::process(&mut self.requests, |request, gas_limit| {
                // Read the id before the request is moved into handling; a failure
                // rolls back the handler's frame, so the terminal event for a
                // failed request must come from here, in the driver's own
                // (committed) frame.
                let request_id = request.request_id;
                let result = cfg
                    .handler()
                    .with_commit_locking()
                    .with_gas_limit(gas_limit)
                    .try_handle_request(request);
                if result.is_err() {
                    log_event(&RequestFailed::new(request_id));
                }
                result
            });

        // Every request the batch took is out of the queue -- including the
        // ones whose handling failed -- so its room comes back.
        self.slots.release(n_processed);

        (n_processed, n_failed)
    }
}
