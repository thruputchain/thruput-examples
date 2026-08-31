//! The high-level router interface (cf. UniswapV2Router).

use crate::{
    Address, Amount, Amounts, ERC20Error, RequestId, SwapFactoryError, SwapLibraryError,
    SwapPairError, SwapRequestError,
};
use sdk::*;

/// Builds [`SwapRequest`](crate::SwapRequest)s from high-level user operations
/// and enqueues them with the driver.  Performs no price calculation itself --
/// the optimizing math happens when requests are dequeued and handled.
///
/// The router resolves each pair through the factory, creating it on first use
/// (cf. UniswapV2Router's `addLiquidity`), so `throws` includes the factory's
/// errors.
/// Errors from the router itself, as opposed to the operations it forwards.
#[contract_exception]
pub enum SwapRouterError {
    /// `initialize` was called on a router that is already running.
    AlreadyInitialized = 1,

    /// The factory has no pool for the requested token pair.
    ///
    /// Unlike UniswapV2's router, this one never creates one: a pool's
    /// contracts are funded as they are deployed, so creating one costs its
    /// creator real HOG and is not something to do as a side effect of adding
    /// liquidity.  Call [`SwapFactory::create_pair`](crate::SwapFactory::create_pair)
    /// first.
    NoSuchPair = 2,
}

#[contract(
    client = SwapRouterClient,
    throws(
        ERC20Error,
        SwapPairError,
        SwapRequestError,
        SwapLibraryError,
        SwapFactoryError,
        SwapRouterError
    )
)]
pub trait SwapRouter {
    /// Initialize the router with the factory it resolves pairs through.
    fn initialize(&mut self, factory: &Address);

    /// Request to provide liquidity, receiving LP tokens in return.
    ///
    /// Returns the [`RequestId`] to track the request by (see
    /// [`SwapDriver::request`](crate::SwapDriver::request)).
    fn add_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        amounts_desired: Amounts,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> RequestId;

    /// Request to burn `liquidity` LP tokens, recovering the underlying tokens.
    ///
    /// Returns the [`RequestId`] to track the request by.
    fn remove_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        liquidity: Amount,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> RequestId;

    /// Request to swap an exact input amount for as much output as possible.
    ///
    /// Returns the [`RequestId`] to track the request by.
    fn swap_exact_tokens_for_tokens(
        &self,
        amount_in: Amount,
        amount_out_min: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    ) -> RequestId;

    /// Request to swap as little input as possible for an exact output amount.
    ///
    /// Returns the [`RequestId`] to track the request by.
    fn swap_tokens_for_exact_tokens(
        &self,
        amount_out: Amount,
        amount_in_max: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    ) -> RequestId;
}
