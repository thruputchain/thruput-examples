//! The request-batching driver interface.

use crate::{
    Address, ERC20Error, RequestAccepted, RequestFailed, RequestId, RequestsProcessed,
    SwapLibraryError, SwapPairError, SwapRequest, SwapRequestError,
};
use sdk::*;

/// Errors from the driver itself, as opposed to the requests it carries.
#[contract_exception]
pub enum SwapDriverError {
    /// The crank did not bring enough gas to be worth the block's one drain
    /// opportunity.
    ///
    /// Only one transaction per block can drain a given queue, so a crank
    /// funded for a request or two would spend that block's single opportunity
    /// on almost nothing while a larger one waited.  A crank must therefore be
    /// able to take what is waiting, up to the `min_crank_batch` the driver was
    /// initialized with; bring at least `process_requests_gas` of that.
    BatchTooSmall = 1,
}

/// A driver that batches [`SwapRequest`]s and forwards each to the handler,
/// all in one block.
#[contract(
    client = SwapDriverClient,
    throws(ERC20Error, SwapPairError, SwapRequestError, SwapLibraryError, SwapDriverError),
    emits(RequestAccepted, RequestFailed, RequestsProcessed)
)]
pub trait SwapDriver {
    /// Must be called exactly once before any other methods.
    ///
    /// `max_queue_len` caps how many requests may wait at once.  Requests
    /// arriving at a full queue are deferred, not rejected: see
    /// [`request`](Self::request).
    ///
    /// `min_crank_batch` is the most a crank can be required to clear before it
    /// is allowed to drain at all — it must be able to take whatever is
    /// waiting, up to this many.  Both are set per pool because they trade off
    /// against each other and against how a pool is used: see
    /// [`process_requests`](Self::process_requests) and
    /// [`SwapDriverError::BatchTooSmall`].  `min_crank_batch` must not exceed
    /// `max_queue_len`, which would ask for a batch the queue can never hold.
    fn initialize(&mut self, handler: &Address, max_queue_len: u32, min_crank_batch: u32);

    /// Enqueue a request to be handled later, when `process_requests` runs.
    ///
    /// Returns the [`RequestId`] stamped on the request, which the caller can
    /// match against the event the request eventually produces.
    ///
    /// **Known gap.**  This accepts a whole [`SwapRequest`] from any caller,
    /// including the account it names as the operation's sender.  The router
    /// records the true caller when it builds a request, but nothing obliges
    /// anyone to go through the router: an attacker can enqueue a request
    /// naming a victim as the sender and itself as the recipient, and the
    /// handler will then spend the victim's allowance to it.  Closing this
    /// means admitting only the router here, as
    /// [`SwapPair`](crate::SwapPair) admits only its handler -- which needs
    /// the driver to be told the router's address at initialization, and so
    /// the factory to be told it too.
    ///
    /// A request that would take the queue past the `max_queue_len` given at
    /// initialization does not fail: its transaction is excluded from the block
    /// and returned to the mempool, so it lands once a `process_requests` has
    /// freed room.  A caller that cannot wait indefinitely bounds that with the
    /// transaction's own expiry height.
    fn request(&mut self, request: SwapRequest) -> RequestId;

    /// Drain the queue, returning `(processed, failed)` counts.  Each failed
    /// request emits a [`RequestFailed`] carrying its [`RequestId`], and a
    /// batch that processed anything emits one [`RequestsProcessed`]
    /// summarizing it.
    ///
    /// How much is drained is up to the caller: the batch runs until the queue
    /// empties or the calling frame runs out of gas, so the declared gas limit
    /// is the batch size (size one with `swap_driver::process_requests_gas`).
    ///
    /// Almost up to the caller: once the queue is deep, a crank that cannot
    /// make real progress is refused with [`SwapDriverError::BatchTooSmall`],
    /// rather than being allowed to spend the block's one drain on a single
    /// request.  A crank on a shallow queue may be as small as it likes.
    ///
    /// Call this in a transaction of its own, never combined with a
    /// [`request`](Self::request) -- see the `batch_driver` module docs for
    /// why combining the two delays the very request it would try to hurry.
    fn process_requests(&mut self) -> (u32, u32);
}
