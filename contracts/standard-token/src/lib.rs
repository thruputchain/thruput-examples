//! Metadata-enabled ERC20 used by the standard token factory.
//!
//! This contract deliberately inherits the Groundhog ERC20 `0.1.9` behavior:
//! amounts are bounded by `i128::MAX`, allowance events contain a signed delta,
//! and successful zero-value ERC20 operations still emit their standard events.
//! Native HOG is protocol-managed rather than an instance of this contract, so
//! native funding, fees, and protocol-level HOG behavior are outside this ABI.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

mod implementation;

pub use groundhog_erc20_if::{
    Amount, ApprovalEvent, CONTRACT_ADDR_ZERO, Difference, ERC20, ERC20Client, ERC20Error,
    TransferEvent,
};
pub use groundhog_erc20_metadata_if::{ERC20Metadata, ERC20MetadataClient, Name, Symbol};
pub use implementation::{Config, TokenContract};
pub use standard_token_factory_if::{StandardTokenInitializer, StandardTokenInitializerClient};

#[cfg(feature = "dev")]
pub use implementation::balance_storage_key;
