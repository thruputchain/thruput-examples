#![cfg_attr(not(feature = "dev"), no_std)]

mod implementation;
pub use implementation::*;

thruput_sdk::declare_mock_contract!();
