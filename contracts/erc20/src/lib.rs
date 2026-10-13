//! ERC20 contract interface and implementation

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

// A trait describing the contract interface
mod interface {
    pub use thruput_erc20_controls_if::{
        ClawbackEvent, ERC20Burn, ERC20BurnClient, ERC20Clawback, ERC20ClawbackClient,
    };
    pub use thruput_erc20_if::*;

    #[cfg(feature = "metadata")]
    pub use thruput_erc20_metadata_if::*;

    #[cfg(feature = "permit")]
    pub use thruput_erc20_permit_if::*;
}

// A client stub that provides the interface via cross-contract calls
pub use interface::ERC20Client;

// Destruction lives in extensions: holders burn what they hold (or hold an
// allowance for) through `ERC20Burn`; the administrator forces a burn from
// any holder through `ERC20Clawback`.
pub use interface::{
    ClawbackEvent, ERC20Burn, ERC20BurnClient, ERC20Clawback, ERC20ClawbackClient,
};

#[cfg(feature = "metadata")]
pub use interface::ERC20MetadataClient;

#[cfg(feature = "permit")]
pub use interface::{
    DeleteAllowanceGrant, DeleteAllowanceRequest, ERC20Permit, ERC20PermitClient, ERC20PermitError,
    PermitGrant, PermitRequest,
};

// An implementation of the contract interface
mod implementation;

// The actual implementation, exposed for use in tests
pub use implementation::TokenContract;

// Re-export the ERC20 trait so tests can write `dyn erc20::ERC20`, and its
// error so they can name what a refused call throws.
pub use interface::{ERC20, ERC20Error};
