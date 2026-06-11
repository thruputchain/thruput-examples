#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

// Interface
pub use library::SwapLibraryError;
pub use router::{RouterClient, SwapRouterError};

// Implementation
mod cfg;
mod library;
mod router;
pub use router::Router;
