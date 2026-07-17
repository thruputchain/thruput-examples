use crate::SwapRequest;
use crate::library::SwapLibraryError;
pub use groundhog_erc20_if::ERC20Error;
use sdk::*;
use swap::{Address, ISwapV2PairError};

/// Errors raised while handling a swap request (slippage limits exceeded).
#[contract_exception]
pub enum SwapRequestError {
    InsufficientAmountA = 1,
    InsufficientAmountB = 2,
    InsufficientOutputAmount = 3,
    ExcessiveInputAmount = 4,
}

/// The handler that performs high-level swap operations.
///
/// The driver enqueues opaque [`SwapRequest`]s and later forwards each one
/// here (commit-locked and gas-limited).  This contract reads the live
/// reserves, performs the optimizing calculation, moves the user's tokens, and
/// calls into the `swap` pair to do the underlying work.
#[contract(
    client = ISwapRequestHandlerClient,
    throws(SwapRequestError, ISwapV2PairError, ERC20Error, SwapLibraryError)
)]
pub trait ISwapRequestHandler {
    /// Must be called exactly once before any other methods.
    ///
    /// `swap_pair` is the pair this handler drives; `token0`/`token1` are its
    /// underlying tokens (the LP-token address is read from the pair).
    fn initialize(&mut self, swap_pair: &Address, token0: &Address, token1: &Address);

    /// Handle a single swap request, performing the underlying `swap`
    /// operations.
    fn handle_request(&mut self, request: SwapRequest);
}
