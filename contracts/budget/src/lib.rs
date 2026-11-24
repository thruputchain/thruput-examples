#![cfg_attr(not(feature = "dev"), no_std)]

thruput_sdk::declare_mock_contract!();

mod bucket;
mod implementation;

pub use bucket::{Limit, refill};
pub use implementation::*;
