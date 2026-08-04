//! The fundamental swap-pair operations (cf. UniswapV2Pair).

use crate::{Address, Amount, Amounts, BurnEvent, ERC20Error, MintEvent, SwapEvent, SyncEvent, U256};
use core::fmt;
use sdk::*;

#[contract_exception]
#[non_exhaustive]
pub enum SwapPairError {
    InitializeFailed = 1,
    AlreadyInitialized = 2,
    NoLiquidityToBurn = 3,
    InsufficientOutputAmount = 4,
    InsufficientInputAmount = 5,
    InsufficientLiquidity = 6,
    InsufficientLiquidityMinted = 7,
    InsufficientLiquidityBurned = 8,
    InvalidDestination = 9,
    InvalidSwapProduct = 10,
    Overflow = 11,
    TransferFailed = 12,
    LPTokenFailure(ERC20Error) = 13,
}

impl fmt::Display for SwapPairError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SwapV2{:?}", self)
    }
}

#[contract(
    client = SwapPairClient,
    throws(SwapPairError, ERC20Error),
    emits(MintEvent, BurnEvent, SwapEvent, SyncEvent)
)]
pub trait SwapPair {
    /// Must be called exactly once before any other methods
    fn initialize(
        &mut self,
        factory: &Address,
        token0: &Address,
        token1: &Address,
        // A deployed but *uninitialized* ERC20 token contract.  This method
        // adopts it as the LP token and initializes it under the pair's
        // control.
        lp_token: &Address,
    );

    fn liquidity_token(&self) -> ContractAddress;

    fn get_reserves(&self) -> (u128, u128, u32);
    fn get_liquidity(&self) -> Amount;
    /// The last-recorded cumulative prices, as UQ112x112 fixed-point values
    /// (`[price0, price1]`), for use as a time-weighted-average-price oracle.
    fn get_cumulative_prices(&self) -> [U256; 2];

    fn mint_lp(&mut self, to: &Address) -> Amount;
    fn burn_lp(&mut self, to: &Address) -> Amounts;

    fn skim(&mut self, to: &Address);
    fn sync(&mut self);

    fn swap(&mut self, amount0_out: Amount, amount1_out: Amount, to: &Address);
}
