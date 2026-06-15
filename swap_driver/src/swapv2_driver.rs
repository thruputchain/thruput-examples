//! An abstract request-batching driver.
//!
//! The driver knows nothing about the *shape* of the requests it batches: it
//! enqueues opaque [`SwapRequest`] values and, when `process_requests` runs,
//! forwards each one to the configured handler contract.  Each request reports
//! its own gas budget via the [`Request`] trait, so the batching pattern here
//! can be duplicated for other contracts simply by swapping the request type
//! and handler client.

use crate::cfg::*;
use sdk::storage::*;
use sdk::*;
use swap::ISwapV2PairError;
use swap_request::*;

// How much gas a batch may consume before we stop and defer the rest.
// (Sized to allow about 10 requests per batch.)
const BATCH_GAS_HIGH_WATER: u64 = 9 * SwapRequest::GAS_LIMIT;

/// State for the driver contract
#[storage]
pub struct SwapV2Driver {
    // Configuration
    cfg: Value<Cfg>,

    // Requests (can be enqueued concurrently)
    requests: RCQ<SwapRequest>,
}

#[contract(throws(ERC20Error, ISwapV2PairError, SwapRequestError, SwapLibraryError))]
impl SwapV2Driver {
    // Must be called exactly once before any other methods
    pub fn initialize(&mut self, handler: &ContractAddress) {
        if self.cfg.try_get().is_some() {
            panic!("Already initialized.");
        }

        let cfg = Cfg { handler: *handler };

        // Ensure only one `initialize` call can succeed per block.
        self.cfg.set_exclusive(&cfg);
    }

    // Enqueue a request to be handled later, when `process_requests` runs.
    pub fn request(&mut self, request: SwapRequest) {
        self.requests.insert(&request);
    }

    pub fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        let mut n_processed = 0;
        let mut n_failed = 0;
        let mut batch_gas_consumed_max = 0u64;

        while let Some(req) = self.requests.try_consume() {
            // Each request knows how much gas its handling deserves.
            let gas_limit = req.gas_limit();

            // Handle the request in isolation: commit-locking lets a failed
            // request roll back without aborting the rest of the batch.
            cfg.handler()
                .with_commit_locking()
                .with_gas_limit(gas_limit)
                .try_handle_request(req)
                .unwrap_or_else(|e| {
                    request_failed(&e);
                    n_failed += 1;
                });

            batch_gas_consumed_max += gas_limit;
            n_processed += 1;

            if batch_gas_consumed_max > BATCH_GAS_HIGH_WATER {
                break;
            }
        }

        (n_processed, n_failed)
    }
}

fn request_failed(e: &ISwapRequestHandlerClientError) {
    #[cfg(feature = "dev")]
    println!("!! request failed: {e:?}");

    #[cfg(not(feature = "dev"))]
    {
        let _ = e;
    }

    // TODO: emit event
}
