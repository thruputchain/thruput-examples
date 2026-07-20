//! A request-batching driver for `swap_request`.
//!
//! This is a thin, concrete shell around the reusable [`batch_driver`] core: it
//! owns the queue of [`SwapRequest`]s and supplies the one swap-specific piece
//! the core can't know -- how to forward a request to the handler contract.
//! The drain/gas/failure-accounting loop itself lives in `batch_driver::process`
//! and is shared by any driver, whatever its request type.

use crate::cfg::*;
use sdk::storage::*;
use sdk::*;
use swap_pair::SwapPairError;
use swap_request::*;

/// State for the driver contract
#[storage]
pub struct SwapV2Driver {
    // Configuration
    cfg: Value<Cfg>,

    // Requests (can be enqueued concurrently)
    requests: RCQ<SwapRequest>,
}

/// Recommended gas limit for `process_requests()`
///   (some overhead plus enough for ~10 requests).
pub const PROCESS_REQUESTS_GAS: u64 = 10_000 + (10 * REQUEST_GAS_MAX);

#[contract(throws(ERC20Error, SwapPairError, SwapRequestError, SwapLibraryError))]
impl SwapV2Driver {
    /// Must be called exactly once before any other methods
    pub fn initialize(&mut self, handler: &ContractAddress) {
        if self.cfg.try_get().none_if_missing().is_some() {
            panic!("Already initialized.");
        }

        let cfg = Cfg { handler: *handler };

        // Ensure only one `initialize` call can succeed per block.
        self.cfg.set_exclusive(&cfg);
    }

    /// Enqueue a request to be handled later, when `process_requests` runs.
    pub fn request(&mut self, request: SwapRequest) {
        self.requests.insert(&request);
    }

    pub fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        batch_driver::process(&mut self.requests, |request, gas_limit| {
            cfg.handler()
                .with_commit_locking()
                .with_gas_limit(gas_limit)
                .try_handle_request(request)
        })
    }
}
