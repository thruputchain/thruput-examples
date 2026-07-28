//! The high-level router interface (cf. UniswapV2Router).

use crate::{
    Address, Amount, Amounts, ERC20Error, SwapFactoryError, SwapLibraryError, SwapPairError,
    SwapRequestError,
};
use sdk::*;

/// Builds [`SwapRequest`](crate::SwapRequest)s from high-level user operations
/// and enqueues them with the driver.  Performs no price calculation itself --
/// the optimizing math happens when requests are dequeued and handled.
///
/// The router resolves each pair through the factory, creating it on first use
/// (cf. UniswapV2Router's `addLiquidity`), so `throws` includes the factory's
/// errors.
#[contract(
    client = SwapRouterClient,
    throws(ERC20Error, SwapPairError, SwapRequestError, SwapLibraryError, SwapFactoryError)
)]
pub trait SwapRouter {
    /// Initialize the router with the factory it resolves pairs through.
    fn initialize(&mut self, factory: &Address);

    /// Request to provide liquidity, receiving LP tokens in return.
    fn add_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        amounts_desired: Amounts,
        amounts_min: Amounts,
        recipient: &Address,
    );

    /// Request to burn `liquidity` LP tokens, recovering the underlying tokens.
    fn remove_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        liquidity: Amount,
        amounts_min: Amounts,
        recipient: &Address,
    );

    /// Request to swap an exact input amount for as much output as possible.
    fn swap_exact_tokens_for_tokens(
        &self,
        amount_in: Amount,
        amount_out_min: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    );

    /// Request to swap as little input as possible for an exact output amount.
    fn swap_tokens_for_exact_tokens(
        &self,
        amount_out: Amount,
        amount_in_max: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    );
}
