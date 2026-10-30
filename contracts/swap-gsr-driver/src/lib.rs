#![cfg_attr(not(feature = "dev"), no_std)]

thruput_sdk::declare_mock_contract!();

mod cfg;
mod driver;
pub mod gsr;
pub mod lanes;

// Interface (defined in `swap-if`), re-exported for convenience. This driver implements the same
// `SwapDriver` as `swap-driver`, so a factory deploys either one by its code hash.
pub use swap_if::{RequestId, SwapDriver, SwapDriverClient, SwapDriverError};

// The events this contract emits are the batching pattern's own; see `swap-driver`.
pub use batch_driver::{Cause, RequestAccepted, RequestFailed, RequestsProcessed};

// Contract implementation
pub use driver::{Driver, process_requests_gas};
