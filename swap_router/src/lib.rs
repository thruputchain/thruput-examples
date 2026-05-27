#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

// Interface
pub use router::{RouterClient, SwapRouterError};
pub use library::SwapLibraryError;

// Implementation
mod cfg;
mod router;
mod library;

#[cfg(feature = "dev")]
pub use router::Router;
