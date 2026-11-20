//! A request-batching driver for `swap_handler` that orders each crank by GSR.
//!
//! This is `swap-driver` with its one queue split into lanes: a request is put in the lane for
//! the way it moves the price when it is enqueued, and the crank takes from whichever lane
//! [`Gsr`] chooses, one block's requests at a time. Everything else -- who may enqueue, the crank's floor and claim, the isolation
//! of each request, the events -- is the batch-driver pattern's, as there. It implements the same
//! `SwapDriver` interface, so a factory deploys it in place of `swap-driver` simply by being given
//! its code hash.

use crate::cfg::*;
use crate::gsr::{Gsr, LANES, Pool, Start, lane_of};
use crate::lanes::{LanedQueue, gas_for_laned_batch};
use batch_driver::CrankPolicy;
use swap_if::*;
use thruput_sdk::storage::*;
use thruput_sdk::*;

/// State for the driver contract
#[storage]
pub struct Driver {
    // Who this driver takes requests from, and hands them to.
    cfg: Value<Cfg>,

    // The requests themselves, in their lanes, together with policy for capacity and batch-size;
    // see `crate::lanes::LanedQueue`.
    queue: Node<LanedQueue<SwapRequest, LANES>>,

    // The p₀ of a batch a crank left unfinished; see `crate::gsr`.
    start: Value<Start>,
}

// The pool, as GSR sees it: the handler's reserves, and the driver's stored p₀.
struct HandlerPool<'a> {
    cfg: &'a Cfg,
    start: &'a mut Value<Start>,
}

impl Pool for HandlerPool<'_> {
    fn reserves(&mut self) -> Amounts {
        self.cfg.handler().pool_state().reserves
    }

    fn suspended(&mut self) -> Option<Start> {
        self.start.try_get().none_if_missing()
    }

    fn suspend(&mut self, start: &Start) {
        self.start.set(start);
    }
}

/// The gas limit to declare on a `process_requests()` call intended to drain up to `batch_size`
/// requests.
///
/// As with `swap-driver`, the caller's declared limit *is* the batch size, and the crank streams:
/// requests that cost less than their worst case leave room for more. Each request costs a little
/// more here, for choosing its lane; see [`PICK_GAS`](crate::gsr::PICK_GAS).
pub const fn process_requests_gas(batch_size: u32) -> u64 {
    gas_for_laned_batch::<SwapRequest, Gsr<HandlerPool>, LANES>(batch_size)
}

#[contract(exports = "swap_gsr_driver_exports")]
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
        // Only the router knows who made a request; see `swap-driver`.
        ensure(
            get_caller() == self.cfg.get().router,
            SwapDriverError::Unauthorized,
        );

        let lane = lane_of(&request.op);
        self.queue.enqueue(lane, |id| request.with_request_id(id))
    }

    fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        self.queue
            .crank(
                || cfg.handler().with_commit_locking().try_claim_crank(),
                // The rule asks which side of p₀ the pool's price is on, and the pool answers.
                Gsr::new(HandlerPool {
                    cfg: &cfg,
                    start: &mut self.start,
                }),
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
