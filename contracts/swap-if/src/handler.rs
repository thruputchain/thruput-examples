//! The high-level swap-request handler interface.

use crate::{
    Address, Amount, BurnEvent, ERC20Error, MintEvent, SwapEvent, SwapPairError, SwapRequest,
    SyncEvent, U256,
};
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
/// performs the underlying pair operations *itself* -- the pair is code it
/// runs, not a contract it calls, so a batch of requests shares one invocation.
///
/// It is therefore also the pool: it holds the pooled tokens, administers the
/// LP token, and answers for the pair's state.
#[contract(
    client = SwapHandlerClient,
    throws(SwapRequestError, SwapPairError, ERC20Error, SwapLibraryError),
    emits(MintEvent, BurnEvent, SwapEvent, SyncEvent)
)]
pub trait SwapHandler {
    /// Must be called exactly once before any other methods.
    ///
    /// `factory` is consulted for the protocol `fee_to`; `token0`/`token1` are
    /// the pool's underlying tokens; `lp_token` is a deployed but
    /// *uninitialized* ERC20 contract, which this method adopts as the LP
    /// token and initializes under its own control.
    fn initialize(
        &mut self,
        factory: &Address,
        token0: &Address,
        token1: &Address,
        lp_token: &Address,
    );

    /// Handle a single swap request, performing the underlying `swap`
    /// operations.
    fn handle_request(&mut self, request: SwapRequest);

    /// The LP token this pool mints and burns.
    fn liquidity_token(&self) -> ContractAddress;

    /// The last-recorded reserves, and when they were recorded.
    fn get_reserves(&self) -> (u128, u128, u32);

    /// The total supply of LP tokens.
    fn get_liquidity(&self) -> Amount;

    /// The last-recorded cumulative prices, as UQ112x112 fixed-point values
    /// (`[price0, price1]`), for use as a time-weighted-average-price oracle.
    fn get_cumulative_prices(&self) -> [U256; 2];

    /// Send any balance in excess of the recorded reserves to `to`.
    ///
    /// Open to anyone, as in UniswapV2: it attributes nothing and can only
    /// move what the reserves do not account for, so it stays available as a
    /// way to recover tokens sent to the pool by mistake.
    fn skim(&mut self, to: &Address);

    /// Record the pool's actual balances as its reserves.
    ///
    /// Open to anyone, for the same reason as [`skim`](Self::skim).
    fn sync(&mut self);
}
