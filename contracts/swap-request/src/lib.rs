//! High-level swap requests and the contract that handles them.
//!
//! This defines a [`SwapRequest`] datatype representing a high-level swap
//! operation, and a handler contract whose [`handle_request`] method services
//! the request by calling operations on the `swap` contract.  The handler is
//! called by `swap_driver::process_requests`.
//!
//! [`handle_request`]: SwapRequestHandler::handle_request

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

pub(crate) mod u256;

// Interface (the parts the driver and router depend on)
mod request;
pub use request::*;

mod interface;
pub use interface::*;

mod library;
pub use library::*;

// Implementation (the deployable handler contract)
#[cfg(feature = "implementation")]
mod cfg;
#[cfg(feature = "implementation")]
mod handler;
#[cfg(feature = "implementation")]
pub use handler::*;
