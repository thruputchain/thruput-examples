//! One contract, two kinds of `#[contract]` surface.
//!
//! `#[contract]` can go on an inherent impl or on a trait impl, and a single
//! contract type may carry both at once. This example puts them side by side:
//!
//! - the inherent ("notrait") impl on [`Vault`] is a self-contained interface
//!   whose methods are defined directly on the type, and generates
//!   [`VaultClient`];
//! - the [`Resettable`] trait impl exports a reusable interface others can
//!   also implement, and generates `ResettableClient` from the *trait*.
//!
//! Both surfaces share one storage struct, and callers reach both through the
//! same deployed address — see `tests/test.rs`.
//!
//! The placement rules that differ between the two:
//!
//! - `throws` belongs to the *interface*. For the inherent impl the impl is
//!   the interface, so it goes there. For a trait it goes on the trait
//!   definition, never on the trait impl.
//! - `client = ...` likewise. The trait is authoritative for its client name,
//!   so repeating it on the trait impl is rejected at compile time.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::Value;
use sdk::*;

sdk::declare_mock_contract!();

/// Largest value the vault will accept.
const MAX_VALUE: u64 = 1_000_000;

/// Error type for the inherent (`notrait`) interface.
#[contract_exception]
pub enum VaultError {
    ValueTooLarge = 1,
}

/// Error type for the [`Resettable`] interface.
#[contract_exception]
pub enum ResettableError {
    AlreadyReset = 1,
}

/// A reusable interface any contract can implement.
///
/// `throws` sits on the trait definition because the trait is the interface;
/// the impl below must not repeat it.
#[contract(throws = ResettableError)]
pub trait Resettable {
    fn reset(&mut self);
}

/// Shared state behind both surfaces.
#[sdk::storage]
pub struct Vault {
    value: Value<u64>,
}

/// The inherent (`notrait`) surface: methods defined directly on the type.
///
/// Generates `VaultClient`, and takes `throws` because this impl *is* the
/// interface.
#[contract(throws = VaultError)]
impl Vault {
    pub fn set(&mut self, value: u64) {
        if value > MAX_VALUE {
            throw(VaultError::ValueTooLarge);
        }
        self.value.set(&value);
    }

    pub fn get(&self) -> u64 {
        self.value.try_get().none_if_missing().unwrap_or(0)
    }
}

/// The trait surface: the same contract also exports [`Resettable`].
///
/// No `throws` and no `client = ...` here — both belong to the trait.
#[contract]
impl Resettable for Vault {
    fn reset(&mut self) {
        if self.get() == 0 {
            throw(ResettableError::AlreadyReset);
        }
        self.value.set(&0);
    }
}
