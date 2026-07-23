//! The request-batching driver interface.

use crate::{Address, ERC20Error, SwapLibraryError, SwapPairError, SwapRequest, SwapRequestError};
use sdk::*;

/// A driver that batches [`SwapRequest`]s and forwards each to the handler,
/// all in one block.
#[contract(
    client = SwapDriverClient,
    throws(ERC20Error, SwapPairError, SwapRequestError, SwapLibraryError)
)]
pub trait SwapDriver {
    /// Must be called exactly once before any other methods.
    fn initialize(&mut self, handler: &Address);

    /// Enqueue a request to be handled later, when `process_requests` runs.
    fn request(&mut self, request: SwapRequest);

    /// Drain the queue, returning `(processed, failed)` counts.
    fn process_requests(&mut self) -> (u32, u32);
}
