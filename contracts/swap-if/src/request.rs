//! High-level swap request types.

#![allow(clippy::new_ret_no_self)]

use crate::{Address, Amount, Amounts};
use sdk::*;

/// A high-level swap request
///
/// Each variant stores the user's *inputs* (not pre-computed amounts), so the
/// optimizing price calculation can be deferred until the request is handled.
///
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub enum SwapRequest {
    AddLiquidity(AddLiquidityRequest) = 1,
    RemoveLiquidity(RemoveLiquidityRequest) = 2,
    SwapExactIn(SwapExactInRequest) = 3,
    SwapExactOut(SwapExactOutRequest) = 4,
}

impl SwapRequest {
    pub const fn add_liquidity(
        purchaser: &Address,
        amounts_desired: Amounts,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> SwapRequest {
        Self::AddLiquidity(AddLiquidityRequest {
            purchaser: *purchaser,
            amounts_desired,
            amounts_min,
            recipient: *recipient,
        })
    }

    pub const fn remove_liquidity(
        redeemer: &Address,
        liquidity: Amount,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> SwapRequest {
        Self::RemoveLiquidity(RemoveLiquidityRequest {
            redeemer: *redeemer,
            liquidity,
            amounts_min,
            recipient: *recipient,
        })
    }

    pub const fn swap_exact_in(
        trader: &Address,
        amount_in: Amount,
        amount_out_min: Amount,
        in_index: u32,
        recipient: &Address,
    ) -> SwapRequest {
        Self::SwapExactIn(SwapExactInRequest {
            trader: *trader,
            amount_in,
            amount_out_min,
            in_index,
            recipient: *recipient,
        })
    }

    pub const fn swap_exact_out(
        trader: &Address,
        amount_out: Amount,
        amount_in_max: Amount,
        in_index: u32,
        recipient: &Address,
    ) -> SwapRequest {
        Self::SwapExactOut(SwapExactOutRequest {
            trader: *trader,
            amount_out,
            amount_in_max,
            in_index,
            recipient: *recipient,
        })
    }
}

/// Provide liquidity, receiving LP tokens in return.
///
/// The optimal A/B ratio is computed from the live reserves when handled.
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct AddLiquidityRequest {
    // The would-be purchaser of LP tokens (must allow the handler the tokens)
    pub purchaser: Address,

    // The amounts the user would like to provide
    pub amounts_desired: Amounts,

    // The minimum amounts the user will accept providing (slippage limit)
    pub amounts_min: Amounts,

    // The designated receiver of the LP tokens
    pub recipient: Address,
}

/// Burn LP tokens, recovering the underlying A/B tokens.
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct RemoveLiquidityRequest {
    // The would-be redeemer of LP tokens (must allow the handler the LP tokens)
    pub redeemer: Address,

    // Amount of LP tokens to burn
    pub liquidity: Amount,

    // The minimum A/B amounts the user will accept receiving (slippage limit)
    pub amounts_min: Amounts,

    // The designated receiver of the underlying A/B tokens
    pub recipient: Address,
}

/// Swap an exact input amount for as much output as possible.
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct SwapExactInRequest {
    // The trader paying the input amount (must allow the handler the tokens)
    pub trader: Address,

    // The exact amount of the input token to swap in
    pub amount_in: Amount,

    // The minimum amount of the output token the user will accept (slippage)
    pub amount_out_min: Amount,

    // The index (0 or 1) of the input token within the pair
    pub in_index: u32,

    // The designated receiver of the output amount
    pub recipient: Address,
}

/// Swap as little input as possible for an exact output amount.
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct SwapExactOutRequest {
    // The trader paying the input amount (must allow the handler the tokens)
    pub trader: Address,

    // The exact amount of the output token to receive
    pub amount_out: Amount,

    // The maximum amount of the input token the user will pay (slippage)
    pub amount_in_max: Amount,

    // The index (0 or 1) of the input token within the pair
    pub in_index: u32,

    // The designated receiver of the output amount
    pub recipient: Address,
}

// Loose limits, calibrated empirically against the guest (real-fuel) build.
// Liquidity events (mint/burn) also cross-call the factory for the protocol
// `fee_to`, so they carry more headroom than a bare swap.
const ADD_LIQUIDITY_GAS: u64 = 500_000;
const REMOVE_LIQUIDITY_GAS: u64 = 600_000;
const SWAP_GAS: u64 = 400_000;

/// The maximum gas any single request should consume when handled.
pub const REQUEST_GAS_MAX: u64 = REMOVE_LIQUIDITY_GAS;

impl batch_driver::BatchRequest for SwapRequest {
    const GAS_LIMIT: u64 = REQUEST_GAS_MAX;

    fn gas_limit(&self) -> u64 {
        match self {
            SwapRequest::AddLiquidity(_) => ADD_LIQUIDITY_GAS,
            SwapRequest::RemoveLiquidity(_) => REMOVE_LIQUIDITY_GAS,
            SwapRequest::SwapExactIn(_) | SwapRequest::SwapExactOut(_) => SWAP_GAS,
        }
    }
}
