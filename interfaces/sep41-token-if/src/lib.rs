//! The [SEP-41] token interface, for Groundhog contracts.
//!
//! SEP-41 (v0.5.2) is the interface Stellar tokens share. This crate carries
//! over its balance, transfer and burn functions, as [`TokenInterface`], and
//! the events those and minting emit, in [`events`], with SEP-41's names,
//! argument order, argument and return types, and event topics and data.
//!
//! It leaves off the rest of SEP-41:
//!
//! - **Allowances** (`allowance`, `approve`, `transfer_from` and `burn_from`).
//!   SEP-41's allowances are absolute: `approve` sets an allowance to an
//!   amount. That isn't compatible with values that change strictly
//!   relatively, as a Groundhog `Balance` does: it only increases and
//!   decreases, so that concurrent changes merge.
//! - **`name`, `symbol` and `decimals`**. The SEP-41 tokens on Groundhog wrap
//!   Stellar tokens, so a wallet can call the wrapped token's `name`,
//!   `symbol` and `decimals` on Stellar instead.
//! - **Muxed addresses**, which Groundhog has no counterpart for.
//! - **The clawback event.**
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
//!   an address other than its caller's fails.
//! - **An event's name topic** (`"transfer"`) is its signature, topic 0, which
//!   Groundhog derives from the event type's name and the crate defining it.
//!   The topics after it are SEP-41's, and the payload is SEP-41's data; see
//!   [`events`].
//! - **A failure** is an exception the implementation defines. SEP-41 says
//!   when its functions fail and leaves the errors to implementations, so
//!   [`TokenInterface`] declares none, and a token's contract spec lists none
//!   for these functions. A caller catches a token's exceptions by type, with
//!   `sdk::match_exn!`.
//!
//! [SEP-41]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::{ContractAddress, contract};

pub mod events;
pub use events::{Burn, Mint, Transfer};

/// SEP-41's balance, transfer and burn functions.
///
/// Each method is the SEP-41 function of the same name, less its `env: Env`
/// parameter, and each is specified as SEP-41 specifies it. Where SEP-41 has
/// an address `require_auth()`, the address must be the caller.
///
/// SEP-41 also standardizes a [`Mint`] event, but not the function that emits
/// it. An implementation emits it from its own mint function, and lists it in
/// the `emits` of the interface that function belongs to.
#[contract(client = TokenClient, emits(Transfer, Burn))]
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
}
