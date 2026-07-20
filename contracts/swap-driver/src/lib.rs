#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

mod cfg;
mod driver;

// Contract interface
pub use driver::PROCESS_REQUESTS_GAS;
pub use driver::{SwapV2DriverClient, SwapV2DriverClientError};

// Contract implementation
pub use driver::SwapV2Driver;
