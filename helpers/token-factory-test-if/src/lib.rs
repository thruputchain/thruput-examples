//! Shared ABI for token-factory host-test fixtures.
//!
//! These interfaces are test-only and are never part of a release manifest.

#![cfg_attr(not(feature = "dev"), no_std)]

use core::fmt;

use sdk::*;

/// Deterministic fixture failure used to verify transaction rollback.
#[contract_exception]
pub enum TokenFactoryFixtureError {
    /// The child initializer deliberately failed after touching state.
    DeliberateFailure = 1,
}

impl fmt::Display for TokenFactoryFixtureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TokenFactoryFixture{:?}", self)
    }
}

/// Event emitted after an exclusive fixture write.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct ExclusiveWrite {
    /// Value tentatively written by the transaction.
    pub value: u64,
}

/// Minimal caller wallet used by host feasibility tests.
#[contract(client = TokenFactoryTestWalletClient)]
pub trait TokenFactoryTestWallet {
    /// Calls a child probe and returns the immediate caller it observed.
    fn probe_caller(child: &ContractAddress) -> ContractAddress;
}

/// Child fixture used for caller, rollback, and exclusive-write probes.
#[contract(
    client = TokenFactoryFailingChildClient,
    throws = TokenFactoryFixtureError,
    emits(ExclusiveWrite)
)]
pub trait TokenFactoryFailingChild {
    /// Returns the immediate caller of this child frame.
    fn caller(&self) -> ContractAddress;

    /// Writes tentative state and then deterministically aborts.
    fn initialize_failing(&mut self);

    /// Writes a value exclusively and emits a corresponding pending event.
    fn write_exclusive(&mut self, value: u64);

    /// Reads the exclusive value when one has committed.
    fn value(&self) -> Option<u64>;
}
