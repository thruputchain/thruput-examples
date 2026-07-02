#![cfg_attr(not(feature = "dev"), no_std)]

use multi_impl_traits::*;
use sdk::*;

/// A single contract that implements both the Adder and Multiplier traits.
#[sdk::storage]
pub struct MathContract;

#[contract]
impl Adder for MathContract {
    fn add(&self, a: u64, b: u64) -> u64 {
        match a.checked_add(b) {
            Some(result) => result,
            None => throw(AdderError::Overflow),
        }
    }
}

#[contract]
impl Multiplier for MathContract {
    fn multiply(&self, a: u64, b: u64) -> u64 {
        match a.checked_mul(b) {
            Some(result) => result,
            None => throw(MultiplierError::Overflow),
        }
    }

    fn square(&self, a: u64) -> u64 {
        match a.checked_mul(a) {
            Some(result) => result,
            None => throw(MultiplierError::Overflow),
        }
    }
}
