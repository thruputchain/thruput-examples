//! A Stellar-classic account on Thruput.
//!
//! Stellar classic authorizes an operation when the weights of the keys that
//! signed it reach the account's threshold for that operation's category:
//! low, medium, or high. Thruput's protocol has the same shape at the
//! address level: every address carries up to 21 weighted keys and one
//! required weight, and hogd admits a transaction only when its signers'
//! weights reach the larger of that stored weight and the weight the
//! transaction's auth claim asks for.
//!
//! This contract keeps Stellar's three thresholds and pins the chain-enforced
//! required weight to the low one. Each entry point then checks that the
//! transaction's claimed weight reaches its category's threshold, which, given
//! what hogd already verified, is Stellar's threshold check with no signature
//! handling here at all. Signers other than the master live only in the
//! chain's registration; the account mirrors their weights (there is no
//! syscall to read them back) so it can refuse a change that would lock it
//! out.
//!
//! The master key is the account's identity, as in Stellar: it is fixed at
//! creation, only its weight changes, and [`master_key`](StellarAccount::master_key)
//! reports it so the `G...` strkey is recoverable from the account.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

sdk::declare_mock_contract!();

use sdk::*;

mod account;

pub use account::{StellarAccount, StellarAccountClient};
pub use stellar_account_factory_if::{
    AccountCreated, AccountFactoryError, AccountInitError, FactoryConfig,
    StellarAccountFactoryClient, StellarAccountInitializer, StellarAccountInitializerClient,
};

/// Key slots per address: Stellar's 20 signers plus the master key at slot 0.
pub const MAX_SIGNERS: usize = 21;

/// Stellar's operation thresholds. Every value stays at or above 1.
#[contract_type]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Thresholds {
    /// Stored for fidelity; no shipped operation uses it. Also the
    /// chain-enforced required weight.
    pub low: u32,
    /// `payment`, `create_account`, `invoke`.
    pub medium: u32,
    /// `set_signer`, `remove_signer`, `set_master_weight`, `set_thresholds`.
    pub high: u32,
}

/// Everything the account stores.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountConfig {
    /// Immutable after `initialize`.
    pub master_key: Ed25519PublicKey,
    pub thresholds: Thresholds,
    /// Mirror of each slot's registered weight; 0 means the slot is empty.
    pub weights: [u32; MAX_SIGNERS],
}

/// Why the account refused.
#[contract_exception]
#[non_exhaustive]
#[cfg_attr(feature = "dev", derive(thiserror::Error))]
pub enum AccountError {
    /// Called from another contract's frame. The auth claim is verified
    /// against the invoked address, so only a root invocation says anything
    /// about this account's signers.
    #[cfg_attr(
        feature = "dev",
        error("Account operations must be the root invocation")
    )]
    NotRootInvocation = 1,
    /// The claimed required weight is below this operation's threshold, or
    /// the claim is not a source-address claim.
    #[cfg_attr(
        feature = "dev",
        error("Claimed weight is below the operation's threshold")
    )]
    InsufficientAuthWeight = 2,
    /// Slot 0 or a slot at or past 21 for `set_signer`/`remove_signer`,
    /// removing an empty slot (including `set_master_weight(0)` on an empty
    /// slot 0), or `set_signer` with the master key, which already owns slot
    /// 0 (a second slot would count its weight twice).
    #[cfg_attr(feature = "dev", error("Invalid signer slot"))]
    InvalidSlot = 3,
    /// `set_signer` with weight 0; use `remove_signer`.
    #[cfg_attr(feature = "dev", error("Signer weight must be at least 1"))]
    ZeroWeight = 4,
    /// The change would leave total weight below any threshold (low, medium,
    /// or high), or a threshold below 1.
    #[cfg_attr(feature = "dev", error("Change would lock the account out"))]
    WouldLockOut = 5,
    /// `invoke`'s target faulted or the call was rejected before running,
    /// or a called contract returned something inconsistent (the factory
    /// reporting a created address other than the one derived locally).
    #[cfg_attr(feature = "dev", error("Invoked call faulted"))]
    CallFaulted = 6,
}

/// A slot's registration changed; `weight` 0 means it was removed.
#[derive(Event)]
pub struct SignerChanged {
    #[topic]
    pub slot: u32,
    pub weight: u32,
}

#[derive(Event)]
pub struct ThresholdsChanged {
    pub low: u32,
    pub medium: u32,
    pub high: u32,
}
