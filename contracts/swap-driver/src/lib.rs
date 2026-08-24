#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

mod cfg;
mod driver;

// Interface (defined in `swap-if`), re-exported for convenience.
// `RequestFailed` and `RequestsProcessed` are the events this contract emits,
// so they belong on the public surface too.
pub use swap_if::{
    RequestAccepted, RequestFailed, RequestId, RequestsProcessed, SwapDriver, SwapDriverClient,
    SwapDriverClientError, SwapDriverError,
};

// Contract implementation
pub use driver::{Driver, process_requests_gas};
