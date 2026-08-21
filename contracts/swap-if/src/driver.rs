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
    fn initialize(&mut self, handler: &Address);

    /// Enqueue a request to be handled later, when `process_requests` runs.
    ///
    /// Returns the [`RequestId`] stamped on the request, which the caller can
    /// match against the event the request eventually produces.
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
