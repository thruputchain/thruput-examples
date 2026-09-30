//! The [SEP-41] token interface, for Groundhog contracts.
//!
//! SEP-41 (v0.5.2) is the interface Stellar tokens share. This crate carries
//! over its balance, transfer, burn and metadata functions, as
//! [`TokenInterface`], and the events those and minting emit, in [`events`],
//! with SEP-41's names, argument order, argument and return types, and event
//! topics and data. It leaves off SEP-41's allowances (`allowance`,
//! `approve`, `transfer_from` and `burn_from`), its muxed addresses, which
//! Groundhog has no counterpart for, and its clawback event.
//!
//! Where Groundhog has its own mechanism for something SEP-41 relies on, the
//! port uses it:
//!
//! - **`env: Env`** is not a parameter. A Groundhog contract reaches the host
//!   through the SDK's free functions.
//! - **`Address`** is a [`ContractAddress`]. Every Groundhog account is a
//!   contract, usually a wallet.
//! - **`address.require_auth()`** becomes "`address` must be the caller". The
//!   runtime authenticates the contract making a call, so an account
//!   authorizes a call by making it. A call that needs the authorization of
//!   an address other than its caller's throws [`TokenError::Unauthorized`].
//! - **An event's name topic** (`"transfer"`) is its signature, topic 0, which
//!   Groundhog derives from the event type's name and the crate defining it.
//!   The topics after it are SEP-41's, and the payload is SEP-41's data; see
//!   [`events`].
//! - **A failure** is a [`TokenError`] exception. SEP-41 says when its
//!   functions fail and leaves the error encoding to implementations.
//!
//! [SEP-41]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::{ContractAddress, contract, contract_exception};

pub mod events;
pub use events::{Burn, Mint, Transfer};

/// SEP-41's `String`, bounded to 100 bytes so a contract needs no allocator.
///
/// The contract spec, and the bindings generated from it, carry it as a plain
/// string.
pub type String = heapless::String<100>;

/// The ways a SEP-41 function fails.
#[contract_exception]
pub enum TokenError {
    /// An address whose authorization the call needs is not its caller.
    Unauthorized = 1,
    /// `amount` is negative.
    NegativeAmount = 2,
    /// The balance is less than `amount`.
    InsufficientBalance = 3,
    /// The receiving balance would exceed `i128::MAX`.
    BalanceOverflow = 4,
}

/// SEP-41's token interface, less its allowances.
///
/// Each method is the SEP-41 function of the same name, less its `env: Env`
/// parameter, and each is specified as SEP-41 specifies it. Where SEP-41 has
/// an address `require_auth()`, the address must be the caller.
///
/// SEP-41 also standardizes a [`Mint`] event, but not the function that emits
/// it. An implementation emits it from its own mint function, and lists it in
/// the `emits` of the interface that function belongs to.
#[contract(client = TokenClient, throws = TokenError, emits(Transfer, Burn))]
pub trait TokenInterface {
    /// Returns the balance of `id`.
    ///
    /// # Arguments
    ///
    /// - `id` - The address for which a balance is being queried. If the
    ///   address has no existing balance, returns 0.
    fn balance(&self, id: &ContractAddress) -> i128;

    /// Transfer `amount` from `from` to `to`.
    ///
    /// Authorized by `from`, which must be the caller.
    ///
    /// # Arguments
    ///
    /// - `from` - The address holding the balance of tokens which will be
    ///   withdrawn from.
    /// - `to` - The address which will receive the transferred tokens.
    /// - `amount` - The amount of tokens to be transferred.
    ///
    /// # Events
    ///
    /// Emits [`Transfer`] with:
    /// - topics - `[Transfer::SIGNATURE, from: ContractAddress, to: ContractAddress]`
    /// - data - `amount: i128`
    fn transfer(&mut self, from: &ContractAddress, to: &ContractAddress, amount: i128);

    /// Burn `amount` from `from`.
    ///
    /// Authorized by `from`, which must be the caller.
    ///
    /// # Arguments
    ///
    /// - `from` - The address holding the balance of tokens which will be
    ///   burned from.
    /// - `amount` - The amount of tokens to be burned.
    ///
    /// # Events
    ///
    /// Emits [`Burn`] with:
    /// - topics - `[Burn::SIGNATURE, from: ContractAddress]`
    /// - data - `amount: i128`
    fn burn(&mut self, from: &ContractAddress, amount: i128);

    /// Returns the number of decimals used to represent amounts of this
    /// token.
    fn decimals(&self) -> u32;

    /// Returns the name for this token.
    fn name(&self) -> String;

    /// Returns the symbol for this token.
    fn symbol(&self) -> String;
}
