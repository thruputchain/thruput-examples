#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

// Interface (defined in `swap-if`), re-exported for convenience.
pub use swap_if::{SwapRouter, SwapRouterClient, SwapRouterError};

// Implementation
mod cfg;
mod router;
pub use router::Router;
