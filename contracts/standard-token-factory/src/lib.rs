//! Factory for deterministic deployments of the canonical standard token.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

mod implementation;

pub use implementation::StandardTokenFactoryContract;
pub use standard_token_factory_if::{
    Amount, FactoryConfig, Name, StandardTokenFactory, StandardTokenFactoryClient,
    StandardTokenFactoryClientError, Symbol, TokenCreated, TokenFactoryError,
};
