//! Events emitted by the swap contracts.

use crate::{Address, Amount, Amounts, RequestId};
use sdk::*;

/// Emitted by the pair when liquidity is added (`mint_lp`).
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct MintEvent<'a> {
    /// The contract that called `mint`
    #[topic]
    pub sender: &'a Address,

    /// The amount of LP tokens minted
    pub amount_minted: Amount,

    /// The identifier of the batch-request this mint fulfilled, if it
    /// originated from one (see [`RequestId`]).
    pub request_id: Option<RequestId>,
}

impl<'a> MintEvent<'a> {
    pub fn new(sender: &'a Address, amount_minted: Amount, request_id: Option<RequestId>) -> Self {
        Self {
            sender,
            amount_minted,
            request_id,
        }
    }
}

/// Emitted by the pair when liquidity is removed (`burn_lp`).
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct BurnEvent<'a> {
    /// The contract that called `burn`
    #[topic]
    pub sender: &'a Address,

    /// The amounts of reserve tokens redeemed
    pub amounts_redeemed: Amounts,

    /// The recipient of the redeemed tokens
    #[topic]
    pub recipient: &'a Address,

    /// The identifier of the batch-request this burn fulfilled, if it
    /// originated from one (see [`RequestId`]).
    pub request_id: Option<RequestId>,
}

impl<'a> BurnEvent<'a> {
    pub fn new(
        sender: &'a Address,
        amounts_redeemed: Amounts,
        recipient: &'a Address,
        request_id: Option<RequestId>,
    ) -> Self {
        Self {
            sender,
            amounts_redeemed,
            recipient,
            request_id,
        }
    }
}

/// Emitted by the pair on a `swap`.
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct SwapEvent<'a> {
    /// The contract that called `swap`
    #[topic]
    pub sender: &'a Address,

    /// The amounts paid into the swap pair
    pub amounts_in: Amounts,

    /// The amounts returned from the swap pair
    pub amounts_out: Amounts,

    /// The recipient of the swap proceeds
    #[topic]
    pub recipient: &'a Address,

    /// The identifier of the batch-request this burn fulfilled, if it
    /// originated from one (see [`RequestId`]).
    pub request_id: Option<RequestId>,
}

impl<'a> SwapEvent<'a> {
    pub fn new(
        sender: &'a Address,
        amounts_in: Amounts,
        amounts_out: Amounts,
        recipient: &'a Address,
        request_id: Option<RequestId>,
    ) -> Self {
        Self {
            sender,
            amounts_in,
            amounts_out,
            recipient,
            request_id,
        }
    }
}

/// Emitted by the pair whenever the recorded reserves are updated.
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct SyncEvent {
    /// The token-reserve amounts as of the moment of the `sync` call
    pub reserves: Amounts,
}

impl SyncEvent {
    pub fn new(reserves: Amounts) -> Self {
        Self { reserves }
    }
}

/// Emitted by the factory when it creates a pair's contracts (cf. UniswapV2's
/// `PairCreated`).
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct PoolCreated<'a> {
    #[topic]
    pub token0: &'a Address,

    #[topic]
    pub token1: &'a Address,

    pub pair: Address,
    pub liquidity_token: Address,
    pub handler: Address,
    pub driver: Address,

    /// The total number of pairs after this one was created.
    pub pair_count: u32,
}

/// Emitted by the driver when a request is submitted successfully
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestAccepted {
    #[topic]
    pub request_id: RequestId,
}

impl RequestAccepted {
    pub fn new(request_id: RequestId) -> Self {
        Self { request_id }
    }
}

/// Emitted by the driver when a queued request fails during processing.
///
/// A successful request instead surfaces as the pair's own `MintEvent` /
/// `BurnEvent` / `SwapEvent` (which carry the same [`RequestId`]); a failed
/// request's pair-side effects are rolled back by commit-locking, so its
/// terminal event comes from the driver here instead.
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestFailed {
    /// The request that failed (see [`RequestId`]).
    #[topic]
    pub request_id: RequestId,
}

impl RequestFailed {
    pub fn new(request_id: RequestId) -> Self {
        Self { request_id }
    }
}
