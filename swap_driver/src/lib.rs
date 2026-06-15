#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

// Interface
pub use swapv2_driver::{SwapV2DriverClient, SwapV2DriverClientError};

// Re-export the recommended `process_requests` gas limit from where the
// request types (and their gas budgets) are defined.
pub use swap_request::PROCESS_REQUESTS_GAS;

// Implementation
mod cfg;
mod swapv2_driver;
pub use swapv2_driver::SwapV2Driver;
