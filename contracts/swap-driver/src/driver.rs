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

    fn request(&mut self, request: SwapRequest) {
        self.requests.insert(&request);
    }

    fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        batch_driver::process(&mut self.requests, |request, gas_limit| {
            cfg.handler()
                .with_commit_locking()
                .with_gas_limit(gas_limit)
                .try_handle_request(request)
        })
    }
}
