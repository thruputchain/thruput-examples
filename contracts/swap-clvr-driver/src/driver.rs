//! A request-batching driver for `swap_handler` that orders each batch by CLVR.
//!
//! This is `swap-driver` with one change: where that driver hands requests to the handler in the
//! order its queue yields them, this one takes a crank's whole batch out of the queue first and
//! hands it over in the order [`Clvr`](crate::clvr::Clvr) chooses. Everything else -- who may
//! enqueue, the crank's floor and claim, the isolation of each request, the events -- is the
//! batch-driver pattern's, as there. It implements the same `SwapDriver` interface, so a factory deploys it in place of
//! `swap-driver` simply by being given its code hash.

use crate::cfg::*;
use crate::clvr;
use crate::queue::Queue;
use batch_driver::CrankPolicy;
use swap_if::*;
use thruput_sdk::storage::*;
use thruput_sdk::*;

/// State for the driver contract
#[storage]
pub struct Driver {
    // Who this driver takes requests from, and hands them to.
    cfg: Value<Cfg>,

    // The requests themselves, together with policy for capacity and batch-size; see
    // `crate::queue::Queue`.
    queue: Node<Queue>,
}

/// The gas limit to declare on a `process_requests()` call intended to drain up to `batch_size`
/// requests.
///
/// As with `swap-driver`, the caller's declared limit *is* the batch size. Each request costs a
/// little more here, for the ordering; see [`SEQUENCE_GAS`](crate::clvr::SEQUENCE_GAS).
pub const fn process_requests_gas(batch_size: u32) -> u64 {
    crate::queue::gas_for_batch(batch_size)
}

#[contract(exports = "swap_clvr_driver_exports")]
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

        // A crank takes no more than the ordering can hold, so a floor above that could never be
        // met.
        ensure(
            min_crank_batch <= clvr::MAX_BATCH,
            SwapDriverError::InvalidConfiguration,
        );

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
        // Only the router knows who made a request; see `swap-driver`.
        ensure(
            get_caller() == self.cfg.get().router,
            SwapDriverError::Unauthorized,
        );

        self.queue.enqueue(|id| request.with_request_id(id))
    }

    fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        self.queue
            .crank(
                || cfg.handler().with_commit_locking().try_claim_crank(),
                // The order is chosen against the pool's reserves, which the handler holds.
                || cfg.handler().pool_state().reserves,
                |request, gas_limit| {
                    cfg.handler()
                        .with_commit_locking()
                        .with_gas_limit(gas_limit)
                        .try_handle_request(request)
                },
            )
            .unwrap_or_else(|_: batch_driver::Starved| throw(SwapDriverError::BatchTooSmall))
    }
}
