//! Read-only ABI adapter for stellar-oracle-relay's v0.1 `get_price` method.
//! Keep the entrypoint and field order aligned with the relay; see the README.

use thruput_sdk::*;

#[contract_type]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceUpdate {
    pub feed_id: u32,
    pub price: i128,
    pub decimals: u32,
    pub timestamp: u64,
    pub round: u64,
}

#[contract_type]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriceRecord {
    pub observation: PriceUpdate,
    pub accepted_at: u64,
}

/// The relay calls its interface `Contract`; a different name changes the ABI.
#[contract(interface = "Contract", version = "0.1.0", client = OracleClient)]
pub trait Oracle {
    /// Read the stored observation. Oracle exceptions and call faults propagate.
    fn get_price(&self, feed_id: u32) -> PriceRecord;
}
