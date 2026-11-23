#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;
thruput_sdk::declare_mock_contract!();

mod coat;
mod implementation;

pub use coat::{Coat, MAX_DEPTH};
pub use implementation::*;
