#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

mod cfg;
mod driver;

// Interface (defined in `swap-if`), re-exported for convenience.  `RequestFailed`
// is the event this contract emits, so it belongs on the public surface too.
pub use swap_if::{
    RequestAccepted, RequestFailed, RequestId, SwapDriver, SwapDriverClient, SwapDriverClientError,
};

// Contract implementation
pub use driver::{Driver, process_requests_gas};
