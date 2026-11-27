//! A contract that computes on encrypted bits: see [`Fhe`] and the project README.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

thruput_sdk::declare_mock_contract!();

mod contract;
pub use contract::*;
