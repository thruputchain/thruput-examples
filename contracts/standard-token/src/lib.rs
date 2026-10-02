//! Metadata-enabled ERC20 used by the standard token factory.
//!
//! This contract deliberately inherits the Groundhog ERC20 behavior: amounts
//! are signed and bounded by `0..=i128::MAX`, allowance events contain a signed
//! delta, and successful zero-value ERC20 operations still emit their standard
//! events. Destruction lives in the `ERC20Burn` (holder) and `ERC20Clawback`
//! (administrator) extensions.
//! Native HOG is protocol-managed rather than an instance of this contract, so
//! native funding, fees, and protocol-level HOG behavior are outside this ABI.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

mod implementation;

pub use groundhog_erc20_controls_if::{
    ClawbackEvent, ERC20Burn, ERC20BurnClient, ERC20Clawback, ERC20ClawbackClient,
};
pub use groundhog_erc20_if::{
    AllowanceChangeEvent, AllowanceDeleteEvent, Amount, BurnEvent, CONTRACT_ADDR_ZERO, Difference,
    ERC20, ERC20Client, ERC20Error, MintEvent, TransferEvent,
};
pub use groundhog_erc20_metadata_if::{ERC20Metadata, ERC20MetadataClient, Name, Symbol};
pub use implementation::{Config, TokenContract};
pub use standard_token_factory_if::{StandardTokenInitializer, StandardTokenInitializerClient};

#[cfg(feature = "dev")]
pub use implementation::{allowance_storage_key, balance_storage_key};
