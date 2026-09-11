//! A request-batching driver for `swap_handler`.
//!
//! This contract embeds a generic [`batch_driver::Queue`] and then manages a few
//! application-specific details: who may enqueue requests, and how to hand them off to the handler
//! contract.

use crate::cfg::*;
use batch_driver::{CrankPolicy, Queue};
use sdk::storage::*;
use sdk::*;
use swap_if::*;

/// State for the driver contract
#[storage]
pub struct Driver {
    // Who this driver takes requests from, and hands them to.
    cfg: Value<Cfg>,

    // The requests themselves, together with policy for capacity and batch-size; see
    // `batch_driver::Queue`.
    queue: Node<Queue<SwapRequest>>,
}

/// The gas limit to declare on a `process_requests()` call intended to drain up to `batch_size`
/// requests.
///
/// There is no one recommended figure: the drain is bounded by whatever gas its frame has left, so
/// the caller's declared limit *is* the batch size. A caller wanting low latency on its own
/// request, and a small encumbrance of its throughput share, asks for a small batch; one draining a
/// backlog asks for a large one.
pub const fn process_requests_gas(batch_size: u32) -> u64 {
    batch_driver::gas_for_batch::<SwapRequest>(batch_size)
}

#[contract(exports = "swap_driver_exports")]
impl SwapDriver for Driver {
    fn initialize(
        &mut self,
        handler: &Address,
        router: &Address,
        max_queue_len: u32,
        min_crank_batch: u32,
    ) {
        if self.cfg.try_get().none_if_missing().is_some() {
            throw(SwapDriverError::AlreadyInitialized);
        }

        // Initialize the request queue.
        self.queue
            .initialize(CrankPolicy {
                capacity: max_queue_len,
                min_batch: min_crank_batch,
            })
            .unwrap_or_else(|_: batch_driver::InvalidPolicy| {
                throw(SwapDriverError::InvalidConfiguration)
            });

        // Ensure only one `initialize` call can succeed per block.
        self.cfg.set_exclusive(&Cfg {
            handler: *handler,
            router: *router,
        });
    }

    fn request(&mut self, request: SwapRequest) -> RequestId {
        // A request names the account whose tokens it will spend, which this contract cannot check;
        // we depend on the router's record of who made the request, and thus accept requests only
        // from the router.
        ensure(
            get_caller() == self.cfg.get().router,
            SwapDriverError::Unauthorized,
        );

        self.queue.enqueue(|id| request.with_request_id(id))
    }

    fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        self.queue
            .crank(|request, gas_limit| {
                cfg.handler()
                    .with_commit_locking()
                    .with_gas_limit(gas_limit)
                    .try_handle_request(request)
            })
            .unwrap_or_else(|_: batch_driver::Starved| throw(SwapDriverError::BatchTooSmall))
    }
}
