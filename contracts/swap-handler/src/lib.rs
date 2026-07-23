//! The contract that handles high-level swap requests.
//!
//! The request types and the [`SwapHandler`] interface now live in `swap-if`;
//! this crate provides the deployable handler contract (the [`Handler`] struct)
//! and the price-optimizing library it uses.  Interface items are re-exported
//! for convenience.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

// Interface (defined in `swap-if`), re-exported for convenience.
pub use swap_if::{
    AddLiquidityRequest, Address, Amount, Amounts, REQUEST_GAS_MAX, RemoveLiquidityRequest,
    SwapExactInRequest, SwapExactOutRequest, SwapHandler, SwapHandlerClient,
    SwapHandlerClientError, SwapLibraryError, SwapRequest, SwapRequestError,
};

// Price-optimizing calculations used by the handler.
mod library;
pub use library::*;

// Implementation (the deployable handler contract)
#[cfg(feature = "implementation")]
mod cfg;
#[cfg(feature = "implementation")]
mod handler;
#[cfg(feature = "implementation")]
pub use handler::*;
