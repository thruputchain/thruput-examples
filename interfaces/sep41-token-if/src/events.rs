//! SEP-41's events, less its allowance and clawback events.
//!
//! An event's topic 0 is its signature, which stands in for SEP-41's name
//! topic (`"transfer"`, `"burn"`, `"mint"`). Its `#[topic]` fields follow, in
//! SEP-41's order, and its one other field, `amount`, is its data: SEP-41's
//! single-value data format.

use sdk::{ContractAddress, Event};

/// Emitted when an amount is transferred from one address to another.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct Transfer<'a> {
    /// The address holding the balance of tokens that was drawn from.
    #[topic]
    pub from: &'a ContractAddress,
    /// The address that received the tokens.
    #[topic]
    pub to: &'a ContractAddress,
    /// The amount transferred.
    pub amount: i128,
}

/// Emitted when an amount is burned from one address.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct Burn<'a> {
    /// The address holding the balance of tokens that was burned.
    #[topic]
    pub from: &'a ContractAddress,
    /// The amount burned.
    pub amount: i128,
}

/// Emitted when an amount of the token is minted.
///
/// A mint increases total supply and the balance of `to` by the amount
/// minted.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct Mint<'a> {
    /// The address to hold the newly minted tokens.
    #[topic]
    pub to: &'a ContractAddress,
    /// The amount minted.
    pub amount: i128,
}
