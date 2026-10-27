//! The request-batching driver interface.

use crate::{
    Address, ERC20Error, RequestId, SwapLibraryError, SwapPairError, SwapRequest, SwapRequestError,
};
use thruput_sdk::*;

/// Errors from the driver itself, as opposed to the requests it carries.
#[contract_exception]
pub enum SwapDriverError {
    /// The crank did not bring enough gas to be worth the block's one drain opportunity.
    ///
    /// Only one transaction per block can drain a given queue, so a crank funded for a request or
    /// two would spend that block's single opportunity on almost nothing while a larger one waited.
    /// A crank must therefore be able to take what is waiting, up to the `min_crank_batch` the
    /// driver was initialized with; bring at least `process_requests_gas` of that.
    BatchTooSmall = 1,

    /// `initialize` was called on a driver that is already running.
    AlreadyInitialized = 2,

    /// `initialize` was given a `min_crank_batch` larger than the `max_queue_len` it must fit
    /// inside, which no crank could ever satisfy.
    InvalidConfiguration = 3,

    /// `request` was called by something other than the router.
    ///
    /// A request names the account whose tokens it will spend, and nothing here can check that
    /// claim: the router is what sees the account making the call, so only the router may enqueue.
    Unauthorized = 4,
}

/// A driver that batches [`SwapRequest`]s and forwards each to the handler, all in one block.
#[contract(
    client = SwapDriverClient,
    throws(ERC20Error, SwapPairError, SwapRequestError, SwapLibraryError, SwapDriverError),
    emits(
        batch_driver::RequestAccepted,
        batch_driver::RequestFailed,
        batch_driver::RequestsProcessed
    )
)]
pub trait SwapDriver {
    /// Must be called exactly once before any other methods.
    ///
    /// The driver will only accept requests from address `router`.
    ///
    /// `max_queue_len` caps how many requests may wait at once.
    ///
    /// `min_crank_batch` is the most a crank can be required to clear before it is allowed to drain
    /// at all: it must be able to take whatever is waiting, up to this many. `min_crank_batch` must
    /// not exceed `max_queue_len`.
    ///
    /// Both are set per pool because they trade off against each other and against how a pool is
    /// used: see [`process_requests`](Self::process_requests) and
    /// [`SwapDriverError::BatchTooSmall`].
    #[contract(effect = "stateChanging")]
    fn initialize(
        &mut self,
        handler: &Address,
        router: &Address,
        max_queue_len: u32,
        min_crank_batch: u32,
    );

    /// Enqueue a request to be handled later, when `process_requests` runs.
    /// Callable only by the router.
    ///
    /// Returns the [`RequestId`] stamped on the request, which the caller can match against the
    /// event the request eventually produces.
    ///
    /// A request that would take the queue past the `max_queue_len` given at initialization fails
    /// at commit; the transaction may be retried.
    #[contract(effect = "stateChanging")]
    fn request(&mut self, request: SwapRequest) -> RequestId;

    /// Drain the queue, returning `(processed, failed)` counts. Each failed request emits a
    /// [`RequestFailed`](batch_driver::RequestFailed) carrying its [`RequestId`] and why it failed,
    /// and a batch that processed anything emits one
    /// [`RequestsProcessed`](batch_driver::RequestsProcessed) summarizing it.
    ///
    /// How much is drained is up to the caller: the batch runs until the queue empties or the
    /// calling frame runs out of gas, so the declared gas limit is the batch size (size one with
    /// `swap_driver::process_requests_gas`).
    ///
    /// However, once the queue is deep, a crank that cannot make real progress is refused with
    /// [`SwapDriverError::BatchTooSmall`], rather than being allowed to spend the block's one drain
    /// on a single request. A crank on a shallow queue may be as small as it likes.
    ///
    /// Call this in a transaction of its own, never combined with a [`request`](Self::request).
    #[contract(effect = "stateChanging")]
    fn process_requests(&mut self) -> (u32, u32);
}
