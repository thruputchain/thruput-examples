//! The request-batching driver interface.

use crate::{
    Address, ERC20Error, RequestAccepted, RequestFailed, RequestId, SwapLibraryError,
    SwapPairError, SwapRequest, SwapRequestError,
};
use sdk::*;

/// A driver that batches [`SwapRequest`]s and forwards each to the handler,
/// all in one block.
#[contract(
    client = SwapDriverClient,
    throws(ERC20Error, SwapPairError, SwapRequestError, SwapLibraryError),
    emits(RequestAccepted, RequestFailed)
)]
pub trait SwapDriver {
    /// Must be called exactly once before any other methods.
    ///
    /// `max_queue_len` caps how many requests may wait at once.  Each waiting
    /// request costs storage, deposited out of this contract's own HOG balance,
    /// so the cap is what bounds the deposit whoever funds the driver must
    /// stand behind.  Requests arriving at a full queue are deferred, not
    /// rejected: see [`request`](Self::request).
    fn initialize(&mut self, handler: &Address, max_queue_len: u32);

    /// Enqueue a request to be handled later, when `process_requests` runs.
    ///
    /// Returns the [`RequestId`] stamped on the request, which the caller can
    /// match against the event the request eventually produces.
    ///
    /// A request that would take the queue past the `max_queue_len` given at
    /// initialization does not fail: its transaction is excluded from the block
    /// and returned to the mempool, so it lands once a `process_requests` has
    /// freed room.  A caller that cannot wait indefinitely bounds that with the
    /// transaction's own expiry height.
    fn request(&mut self, request: SwapRequest) -> RequestId;

    /// Drain the queue, returning `(processed, failed)` counts.  Each failed
    /// request emits a [`RequestFailed`] carrying its [`RequestId`].
    ///
    /// How much is drained is up to the caller: the batch runs until the queue
    /// empties or the calling frame runs out of gas, so the declared gas limit
    /// is the batch size (size one with `swap_driver::process_requests_gas`).
    ///
    /// Call this in a transaction of its own, never combined with a
    /// [`request`](Self::request) -- see the `batch_driver` module docs for
    /// why combining the two delays the very request it would try to hurry.
    fn process_requests(&mut self) -> (u32, u32);
}
