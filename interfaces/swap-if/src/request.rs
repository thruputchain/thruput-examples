//! High-level swap request types.

#![allow(clippy::new_ret_no_self)]

use crate::{Address, Amount, Amounts, RequestId};
use sdk::*;

/// A high-level swap request, tagged with the [`RequestId`] that tracks it
/// across its lifecycle.
///
/// The constructors leave `request_id` zeroed; the driver stamps the real id
/// when the request is enqueued (see
/// [`SwapDriver::request`](crate::SwapDriver::request)).  The id then rides
/// along through handling and is echoed into the event the request produces,
/// so the off-chain application can match that event back to its submission.
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct SwapRequest {
    /// The id identifying this request, stamped by the driver at enqueue time.
    pub request_id: RequestId,

    /// The operation to perform.
    pub op: SwapOp,
}

/// The operation a [`SwapRequest`] carries.
///
/// Each variant stores the user's *inputs* (not pre-computed amounts), so the
/// optimizing price calculation can be deferred until the request is handled.
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub enum SwapOp {
    AddLiquidity(AddLiquidityRequest) = 1,
    RemoveLiquidity(RemoveLiquidityRequest) = 2,
    SwapExactIn(SwapExactInRequest) = 3,
    SwapExactOut(SwapExactOutRequest) = 4,
}

impl SwapRequest {
    // A freshly built request's id, before the driver stamps the real one.
    const UNSTAMPED: RequestId = RequestId::new([0u8; 32]);

    pub const fn add_liquidity(
        purchaser: &Address,
        amounts_desired: Amounts,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> SwapRequest {
        Self::of(SwapOp::AddLiquidity(AddLiquidityRequest {
            purchaser: *purchaser,
            amounts_desired,
            amounts_min,
            recipient: *recipient,
        }))
    }

    pub const fn remove_liquidity(
        redeemer: &Address,
        liquidity: Amount,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> SwapRequest {
        Self::of(SwapOp::RemoveLiquidity(RemoveLiquidityRequest {
            redeemer: *redeemer,
            liquidity,
            amounts_min,
            recipient: *recipient,
        }))
    }

    pub const fn swap_exact_in(
        trader: &Address,
        amount_in: Amount,
        amount_out_min: Amount,
        in_index: u32,
        recipient: &Address,
    ) -> SwapRequest {
        Self::of(SwapOp::SwapExactIn(SwapExactInRequest {
            trader: *trader,
            amount_in,
            amount_out_min,
            in_index,
            recipient: *recipient,
        }))
    }

    pub const fn swap_exact_out(
        trader: &Address,
        amount_out: Amount,
        amount_in_max: Amount,
        in_index: u32,
        recipient: &Address,
    ) -> SwapRequest {
        Self::of(SwapOp::SwapExactOut(SwapExactOutRequest {
            trader: *trader,
            amount_out,
            amount_in_max,
            in_index,
            recipient: *recipient,
        }))
    }

    // Wrap an `op` as an unstamped request.
    const fn of(op: SwapOp) -> SwapRequest {
        SwapRequest {
            request_id: Self::UNSTAMPED,
            op,
        }
    }

    /// Return this request tagged with `request_id`.  The driver calls this to
    /// stamp the id when enqueuing.
    pub fn with_request_id(mut self, request_id: RequestId) -> Self {
        self.request_id = request_id;
        self
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

// What handling each kind of request may cost.  Calibrated against the guest
// (real-fuel) build by `swap-driver`'s `request_gas` test, which holds each of
// these several times the measured cost.
//
// These are safety limits: the driver caps the handler sub-call at the figure
// its request declares, and a request that outruns its budget fails rather
// than slowing down.  The margin is not free, though -- the drain loop budgets
// `REQUEST_GAS_MAX` per request before taking one, so inflating these makes
// every crank declare more gas than it needs and raises the floor a crank must
// clear before it may drain at all.
//
// Liquidity events carry more headroom than a bare swap: they cross-call the
// factory for the protocol `fee_to`, and when one is configured, every such
// event also takes a square root and some U256 arithmetic in the pair's
// `mint_fee`.  `swap-driver`'s tests cannot reach that branch -- their pairs
// have no factory to consult -- so it is measured separately, by
// `swap-factory`'s `the_protocol_fee_branch_fits_within_the_liquidity_budgets`,
// and these two budgets have to cover the cheap path plus that branch.

/// What handling an [`AddLiquidityRequest`] may cost.
pub const ADD_LIQUIDITY_GAS: u64 = 400_000;

/// What handling a [`RemoveLiquidityRequest`] may cost.
pub const REMOVE_LIQUIDITY_GAS: u64 = 500_000;

/// What handling a [`SwapExactInRequest`] or [`SwapExactOutRequest`] may cost.
pub const SWAP_GAS: u64 = 250_000;

// Every per-operation budget, in one place so that `REQUEST_GAS_MAX` is the
// largest of them by construction.  A new operation belongs here as well as in
// `gas_limit` below -- which the match there will not let anyone forget, and
// which `request_budgets.rs` checks.
const REQUEST_GAS: [u64; 3] = [ADD_LIQUIDITY_GAS, REMOVE_LIQUIDITY_GAS, SWAP_GAS];

/// The maximum gas any single request should consume when handled.
///
/// The largest of the per-operation budgets: the drain loop budgets this much
/// before taking a request it cannot yet see, so it has to bound every one of
/// them.
pub const REQUEST_GAS_MAX: u64 = max(&REQUEST_GAS);

const fn max(budgets: &[u64]) -> u64 {
    let mut most = 0;
    let mut i = 0;
    while i < budgets.len() {
        if budgets[i] > most {
            most = budgets[i];
        }
        i += 1;
    }
    most
}

impl batch_driver::BatchRequest for SwapRequest {
    const GAS_LIMIT: u64 = REQUEST_GAS_MAX;

    fn gas_limit(&self) -> u64 {
        match self.op {
            SwapOp::AddLiquidity(_) => ADD_LIQUIDITY_GAS,
            SwapOp::RemoveLiquidity(_) => REMOVE_LIQUIDITY_GAS,
            SwapOp::SwapExactIn(_) | SwapOp::SwapExactOut(_) => SWAP_GAS,
        }
    }

    fn id(&self) -> RequestId {
        self.request_id
    }
}
