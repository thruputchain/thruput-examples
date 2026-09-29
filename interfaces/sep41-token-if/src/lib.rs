//! The [SEP-41] token interface, for Groundhog contracts.
//!
//! SEP-41 (v0.5.2) is the interface Stellar tokens share: the ten functions of
//! [`TokenInterface`], the five events in [`events`], and the behaviour its
//! doc comments specify. This crate carries it over with SEP-41's names,
//! argument order, argument and return types, and event topics and data, so a
//! Groundhog contract implementing it is called, and reports what it did, the
//! way a Soroban token is.
//!
//! Where Groundhog has its own mechanism for something SEP-41 relies on, the
//! port uses it:
//!
//! - **`env: Env`** is not a parameter. A Groundhog contract reaches the host
//!   through the SDK's free functions.
//! - **[`Address`]** is a [`ContractAddress`](sdk::ContractAddress). Every
//!   Groundhog account is a contract, usually a wallet.
//! - **`address.require_auth()`** becomes "`address` must be the caller". The
//!   runtime authenticates the contract making a call, so an account
//!   authorizes a call by making it. A call that needs the authorization of
//!   an address other than its caller's throws [`TokenError::Unauthorized`].
//! - **A ledger number** is a block height, so `live_until_ledger` is compared
//!   with [`get_block_height`](sdk::get_block_height).
//! - **An event's name topic** (`"transfer"`) is its signature, topic 0, which
//!   Groundhog derives from the event type's name and the crate defining it.
//!   The topics after it are SEP-41's, and the payload is SEP-41's data; see
//!   [`events`].
//! - **A failure** is a [`TokenError`] exception. SEP-41 says when its
//!   functions fail and leaves the error encoding to implementations.
//!
//! [SEP-41]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::{contract, contract_exception, contract_type};

pub mod events;
pub use events::{Approve, Burn, Clawback, Mint, Transfer};

/// SEP-41's `Address`: the address of an account or contract.
pub type Address = sdk::ContractAddress;

/// SEP-41's `String`, bounded to 100 bytes so a contract needs no allocator.
///
/// The contract spec, and the bindings generated from it, carry it as a plain
/// string.
pub type String = heapless::String<100>;

/// SEP-41's `MuxedAddress`: an address, optionally multiplexed with an ID.
///
/// The ID lets one address hold tokens on behalf of many parties, as an
/// exchange crediting deposits to its customers does. The tokens move to
/// `address`; the ID is only reported, as the `to_muxed_id` of the
/// [`Transfer`] event.
#[contract_type]
#[derive(Clone, Copy)]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct MuxedAddress {
    /// The address that receives the tokens.
    pub address: Address,
    /// The muxed ID, or `None` for a plain address.
    pub id: Option<u64>,
}

/// A plain address is a muxed address without an ID, so a `transfer` can be
/// sent to either.
impl From<Address> for MuxedAddress {
    fn from(address: Address) -> Self {
        Self { address, id: None }
    }
}

/// The ways a SEP-41 function fails.
#[contract_exception]
pub enum TokenError {
    /// An address whose authorization the call needs is not its caller.
    Unauthorized = 1,
    /// `amount` is negative.
    NegativeAmount = 2,
    /// `live_until_ledger` is before the current ledger, and the allowance
    /// being set is not 0.
    LiveUntilLedgerInPast = 3,
    /// The allowance is less than `amount`.
    InsufficientAllowance = 4,
    /// The balance is less than `amount`.
    InsufficientBalance = 5,
    /// The receiving balance would exceed `i128::MAX`.
    BalanceOverflow = 6,
}

/// SEP-41's token interface.
///
/// Each method is the SEP-41 function of the same name, less its `env: Env`
/// parameter, and each is specified as SEP-41 specifies it. Where SEP-41 has
/// an address `require_auth()`, the address must be the caller.
///
/// SEP-41 also standardizes a [`Mint`] and a [`Clawback`] event, but not the
/// functions that emit them. An implementation emits them from its own mint
/// and clawback functions, and lists them in the `emits` of the interface
/// those belong to.
#[contract(
    client = TokenClient,
    throws = TokenError,
    emits(Approve, Transfer, Burn)
)]
pub trait TokenInterface {
    /// Returns the amount which `spender` is still allowed to transfer from
    /// `from`.
    ///
    /// # Arguments
    ///
    /// - `from` - The address holding the balance of tokens to be drawn from.
    /// - `spender` - The address spending the tokens held by `from`.
    fn allowance(&self, from: &Address, spender: &Address) -> i128;

    /// Set the allowance of `spender` to `amount`.
    ///
    /// Allows `spender` to transfer from `from` multiple times, up to a total
    /// of `amount`, until `live_until_ledger`. If this function is called
    /// again it overwrites the current allowance with `amount` and
    /// `live_until_ledger`.
    ///
    /// NOTE: An allowance is a spending limit, not a reservation. It does not
    /// lock any of `from`'s balance and may exceed it.
    ///
    /// NOTE: Because calling this function again replaces the current
    /// allowance rather than adding to it, `spender` may spend the current
    /// allowance before the new allowance is set, and so spend more than
    /// intended. Clients SHOULD set the allowance to 0 and confirm that none
    /// of the current allowance was spent before setting a new amount.
    /// Contracts SHOULD NOT require this.
    ///
    /// Authorized by `from`, which must be the caller.
    ///
    /// # Arguments
    ///
    /// - `from` - The address holding the balance of tokens to be drawn from.
    /// - `spender` - The address being authorized to spend the tokens held by
    ///   `from`.
    /// - `amount` - The tokens to be made available to `spender`. Set to 0 to
    ///   revoke the allowance.
    /// - `live_until_ledger` - The ledger number where this allowance
    ///   expires. Cannot be less than the current ledger number unless the
    ///   amount is being set to 0. An expired entry (where live_until_ledger <
    ///   the current ledger number) should be treated as a 0 amount allowance.
    ///
    /// # Events
    ///
    /// Emits [`Approve`] with:
    /// - topics - `[Approve::SIGNATURE, from: Address, spender: Address]`
    /// - data - `{ amount: i128, live_until_ledger: u32 }`
    fn approve(&mut self, from: &Address, spender: &Address, amount: i128, live_until_ledger: u32);

    /// Returns the balance of `id`.
    ///
    /// # Arguments
    ///
    /// - `id` - The address for which a balance is being queried. If the
    ///   address has no existing balance, returns 0.
    fn balance(&self, id: &Address) -> i128;

    /// Transfer `amount` from `from` to `to`.
    ///
    /// Authorized by `from`, which must be the caller.
    ///
    /// # Arguments
    ///
    /// - `from` - The address holding the balance of tokens which will be
    ///   withdrawn from.
    /// - `to` - The address which will receive the transferred tokens. A
    ///   [`MuxedAddress`], or an [`Address`] converted into one.
    /// - `amount` - The amount of tokens to be transferred.
    ///
    /// # Events
    ///
    /// Emits [`Transfer`] with:
    /// - topics - `[Transfer::SIGNATURE, from: Address, to: Address]`
    /// - data - `{ amount: i128, to_muxed_id: Option<u64> }`
    ///
    /// If the transfer involves a muxed address the address and muxed details
    /// are separated in the event.
    fn transfer(&mut self, from: &Address, to: MuxedAddress, amount: i128);

    /// Transfer `amount` from `from` to `to`, consuming the allowance of
    /// `spender`. Authorized by `spender`, which must be the caller.
    ///
    /// Reduces the allowance by `amount` without changing when it expires.
    /// Fails if the allowance or `from`'s balance is less than `amount`.
    ///
    /// # Arguments
    ///
    /// - `spender` - The address authorizing the transfer, and having its
    ///   allowance consumed during the transfer.
    /// - `from` - The address holding the balance of tokens which will be
    ///   withdrawn from.
    /// - `to` - The address which will receive the transferred tokens.
    /// - `amount` - The amount of tokens to be transferred.
    ///
    /// # Events
    ///
    /// Emits [`Transfer`] with:
    /// - topics - `[Transfer::SIGNATURE, from: Address, to: Address]`
    /// - data - `{ amount: i128, to_muxed_id: None }`
    fn transfer_from(&mut self, spender: &Address, from: &Address, to: &Address, amount: i128);

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
    /// - topics - `[Burn::SIGNATURE, from: Address]`
    /// - data - `{ amount: i128 }`
    fn burn(&mut self, from: &Address, amount: i128);

    /// Burn `amount` from `from`, consuming the allowance of `spender`.
    /// Authorized by `spender`, which must be the caller.
    ///
    /// Reduces the allowance by `amount` without changing when it expires.
    /// Fails if the allowance or `from`'s balance is less than `amount`.
    ///
    /// # Arguments
    ///
    /// - `spender` - The address authorizing the burn, and having its
    ///   allowance consumed during the burn.
    /// - `from` - The address holding the balance of tokens which will be
    ///   burned from.
    /// - `amount` - The amount of tokens to be burned.
    ///
    /// # Events
    ///
    /// Emits [`Burn`] with:
    /// - topics - `[Burn::SIGNATURE, from: Address]`
    /// - data - `{ amount: i128 }`
    fn burn_from(&mut self, spender: &Address, from: &Address, amount: i128);

    /// Returns the number of decimals used to represent amounts of this
    /// token.
    fn decimals(&self) -> u32;

    /// Returns the name for this token.
    fn name(&self) -> String;

    /// Returns the symbol for this token.
    fn symbol(&self) -> String;
}
