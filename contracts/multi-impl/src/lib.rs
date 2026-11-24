#![cfg_attr(not(feature = "dev"), no_std)]

use multi_impl_if::*;
use thruput_sdk::*;

/// A single contract that implements both the Adder and Multiplier traits.
#[thruput_sdk::storage]
pub struct MathContract;

#[contract]
impl Adder for MathContract {
    fn add(&self, a: u64, b: u64) -> u64 {
        a.checked_add(b).or_throw(AdderError::Overflow)
    }
}

#[contract]
impl Multiplier for MathContract {
    fn multiply(&self, a: u64, b: u64) -> u64 {
        a.checked_mul(b).or_throw(MultiplierError::Overflow)
    }

    fn square(&self, a: u64) -> u64 {
        a.checked_mul(a).or_throw(MultiplierError::Overflow)
    }
}
