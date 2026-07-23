#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

mod cfg;
mod driver;

// Interface (defined in `swap-if`), re-exported for convenience.
pub use swap_if::{SwapDriver, SwapDriverClient, SwapDriverClientError};

// Contract implementation
pub use driver::{Driver, PROCESS_REQUESTS_GAS};
