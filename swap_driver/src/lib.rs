#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

// Interface
pub use swapv2_driver::{
    SwapV2DriverClient,
    SwapV2DriverClientError,
    PROCESS_REQUESTS_GAS,
};

// Implementation
mod cfg;
mod request;
mod swapv2_driver;
pub use swapv2_driver::SwapV2Driver;
