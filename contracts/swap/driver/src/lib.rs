#![cfg_attr(not(feature = "dev"), no_std)]

thruput_sdk::declare_mock_contract!();

extern crate alloc;

mod cfg;
mod driver;

// Interface (defined in `swap-if`), re-exported for convenience.
pub use swap_if::{RequestId, SwapDriver, SwapDriverClient, SwapDriverError};

// The events this contract emits are the batching pattern's own, and are emitted by the queue
// rather than by anything here; re-exported so a client need not name `batch_driver` to observe
// them.
pub use batch_driver::{Cause, RequestAccepted, RequestFailed, RequestsProcessed};

// Contract implementation
pub use driver::{Driver, process_requests_gas};
