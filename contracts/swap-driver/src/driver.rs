//! A request-batching driver for `swap_handler`.
//!
//! This is a thin, concrete shell around the reusable [`batch_driver`] core: it
//! owns the queue of [`SwapRequest`]s and supplies the one swap-specific piece
//! the core can't know -- how to forward a request to the handler contract.
//! The drain/gas/failure-accounting loop itself lives in `batch_driver::process`
//! and is shared by any driver, whatever its request type.

use crate::cfg::*;
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
}

/// Recommended gas limit for `process_requests()`
///   (some overhead plus enough for ~10 requests).
pub const PROCESS_REQUESTS_GAS: u64 = 10_000 + (10 * REQUEST_GAS_MAX);

#[contract(exports = "swap_driver_exports")]
impl SwapDriver for Driver {
    fn initialize(&mut self, handler: &Address) {
        if self.cfg.try_get().none_if_missing().is_some() {
            panic!("Already initialized.");
        }

        let cfg = Cfg { handler: *handler };

        // Ensure only one `initialize` call can succeed per block.
        self.cfg.set_exclusive(&cfg);
    }

    fn request(&mut self, request: SwapRequest) -> RequestId {
        // Mint an id from the enqueuing transaction's hash plus a sequence
        // number: the tx hash lets the caller correlate the id with its
        // submission, while the sequence keeps requests distinct when several
        // are enqueued in one transaction (they share a tx hash but not a seq).
        self.seq.inc(1);
        let request_id = (get_source_transaction_hash(), self.seq.get()).hash();

        self.requests.insert(&request.with_request_id(request_id));
        request_id
    }

    fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

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
        })
    }
}
