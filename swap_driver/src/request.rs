#![allow(clippy::new_ret_no_self)]

use sdk::*;
use swap::*;

/// A request submitted to the pair contract
#[derive(ReadXDR, WriteXDR)]
#[cfg_attr(feature = "dev", derive(Debug))]
#[xdrs(crate = "::sdk::__xdrs")]
#[repr(i32)]
pub enum Request {
    Purchase(PurchaseRequest),
    Redeem(RedeemRequest),
    Swap(SwapRequest),
}

impl Request {
    pub const fn purchase(purchaser: &Address, amounts: Amounts, recipient: &Address) -> Request {
        Self::Purchase(PurchaseRequest {
            purchaser: *purchaser,
            amounts,
            recipient: *recipient,
        })
    }

    pub const fn redeem(redeemer: &Address) -> Request {
        Self::Redeem(RedeemRequest {
            redeemer: *redeemer,
        })
    }

    pub const fn swap(
        trader: &Address,
        amounts_in: Amounts,
        amounts_out: Amounts,
        recipient: &Address,
    ) -> Request {
        Self::Swap(SwapRequest {
            trader: *trader,
            amounts_in,
            amounts_out,
            recipient: *recipient,
        })
    }
}

#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct PurchaseRequest {
    // The would-be purchaser of LP-tokens
    pub purchaser: Address,
    pub amounts: Amounts,
    pub recipient: Address,
}

#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct RedeemRequest {
    // The would-be redeemer of LP-tokens
    pub redeemer: Address,
}

#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct SwapRequest {
    // The trader paying the in-amounts
    pub trader: Address,

    // Amounts the trader pays in
    pub amounts_in: Amounts,

    // Amounts the trader wishes to extract
    pub amounts_out: Amounts,

    // The designated receiver of the out-amounts
    pub recipient: Address,
}
