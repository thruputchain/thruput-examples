//! The high-level swap-request handler interface.

use crate::{Address, ERC20Error, SwapPairError, SwapRequest};
use sdk::*;

/// Errors raised while handling a swap request (slippage limits exceeded).
#[contract_exception]
pub enum SwapRequestError {
    InsufficientAmountA = 1,
    InsufficientAmountB = 2,
    InsufficientOutputAmount = 3,
    ExcessiveInputAmount = 4,
}

/// Errors from the price-optimizing library calculations.
#[contract_exception]
pub enum SwapLibraryError {
    InsufficientAmount = 1,
    InsufficientLiquidity = 2,
    InsufficientInputAmount = 3,
    InsufficientOutputAmount = 4,
}

/// The handler that performs high-level swap operations.
///
/// The driver enqueues opaque [`SwapRequest`]s and later forwards each one
/// here (commit-locked and gas-limited).  This contract reads the live
/// reserves, performs the optimizing calculation, moves the user's tokens, and
/// calls into the `swap` pair to do the underlying work.
#[contract(
    client = SwapHandlerClient,
    throws(SwapRequestError, SwapPairError, ERC20Error, SwapLibraryError)
)]
pub trait SwapHandler {
    /// Must be called exactly once before any other methods.
    ///
    /// `swap_pair` is the pair this handler drives; `token0`/`token1` are its
    /// underlying tokens (the LP-token address is read from the pair).
    fn initialize(&mut self, swap_pair: &Address, token0: &Address, token1: &Address);

    /// Handle a single swap request, performing the underlying `swap`
    /// operations.
    fn handle_request(&mut self, request: SwapRequest);
}
