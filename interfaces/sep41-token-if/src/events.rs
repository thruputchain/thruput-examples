//! SEP-41's events.
//!
//! An event's topic 0 is its signature, which stands in for SEP-41's name
//! topic (`"approve"`, `"transfer"`, ...). Its `#[topic]` fields follow, in
//! SEP-41's order, and its other fields are its data.
//!
//! SEP-41 lets a token encode event data as a single value or vec, or as a
//! map with `Symbol` keys. A Groundhog event's data is a sequence of fields
//! the contract spec names, so these events use the map format, with SEP-41's
//! keys. Where SEP-41 defines a `to_muxed_id` key, the event has it as an
//! `Option<u64>` that is `None` when there is no muxed ID.

use crate::Address;
use sdk::Event;

/// Emitted when an allowance is set.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct Approve<'a> {
    /// The address holding the balance of tokens to be drawn from.
    #[topic]
    pub from: &'a Address,
    /// The address spending the tokens held by `from`.
    #[topic]
    pub spender: &'a Address,
    /// The amount allowed to be spent.
    pub amount: i128,
    /// The expiration ledger.
    pub live_until_ledger: u32,
}

/// Emitted when an amount is transferred from one address to another.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct Transfer<'a> {
    /// The address holding the balance of tokens that was drawn from.
    #[topic]
    pub from: &'a Address,
    /// The address that received the tokens.
    #[topic]
    pub to: &'a Address,
    /// The amount transferred.
    pub amount: i128,
    /// The muxed ID the tokens were sent to `to` with, if any.
    pub to_muxed_id: Option<u64>,
}

/// Emitted when an amount is burned from one address.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct Burn<'a> {
    /// The address holding the balance of tokens that was burned.
    #[topic]
    pub from: &'a Address,
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
    pub to: &'a Address,
    /// The amount minted.
    pub amount: i128,
    /// The muxed ID the tokens were minted to `to` with, if any.
    pub to_muxed_id: Option<u64>,
}

/// Emitted when an amount of the token is clawed back.
///
/// A clawback is a type of burn: it reduces both the holder's balance and the
/// total supply by the amount clawed back. No [`Burn`] or [`Transfer`] event
/// is emitted alongside it.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct Clawback<'a> {
    /// The address holding the balance from which the clawback took tokens.
    #[topic]
    pub from: &'a Address,
    /// The amount clawed back.
    pub amount: i128,
}
