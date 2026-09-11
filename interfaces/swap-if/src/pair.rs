//! Errors from the fundamental swap-pair operations (cf. UniswapV2Pair).
//!
//! The operations themselves are not a contract: they live in the `swap-pair` crate and run inside
//! the handler's invocation. Their errors stay here because the handler's interface names them, and
//! this crate cannot depend on the implementation.

use crate::ERC20Error;
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
