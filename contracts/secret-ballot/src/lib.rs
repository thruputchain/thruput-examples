#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

pub mod group;
mod implementation;
pub mod proofs;

pub use implementation::*;

thruput_sdk::declare_mock_contract!();
