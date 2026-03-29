#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::*;

/// Error type for the Adder trait.
#[contract_error]
pub enum AdderError {
    Overflow = 1,
}

/// A trait for contracts that can add numbers.
#[contract(throws = AdderError)]
pub trait Adder {
    fn add(&self, a: u64, b: u64) -> u64;
}

/// Error type for the Multiplier trait.
#[contract_error]
pub enum MultiplierError {
    Overflow = 1,
}

/// A trait for contracts that can multiply numbers.
#[contract(throws = MultiplierError)]
pub trait Multiplier {
    fn multiply(&self, a: u64, b: u64) -> u64;
    fn square(&self, a: u64) -> u64;
}
