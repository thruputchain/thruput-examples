//! Shared interfaces and deterministic derivation for token factories.
//!
//! This crate contains ABI definitions only. Deployable token and factory
//! contracts implement these traits without depending on each other.

#![cfg_attr(not(feature = "dev"), no_std)]

pub use thruput_erc20_if::{
    AllowanceChangeEvent, Amount, Difference, ERC20, ERC20Client, ERC20Error, TransferEvent,
};
pub use thruput_erc20_metadata_if::{ERC20Metadata, ERC20MetadataClient, Name, Symbol};
pub use thruput_sdk::{ContractAddress, SHA256Hash};

mod events;
pub use events::TokenCreated;

mod factory;
#[cfg(feature = "remote")]
pub use factory::StandardTokenFactoryRemote;
pub use factory::{
    FactoryConfig, StandardTokenFactory, StandardTokenFactoryClient, TokenFactoryError,
};

mod token;
pub use token::{StandardTokenInitializer, StandardTokenInitializerClient};

use thruput_sdk::{Hash, get_deploy_address_for_other};

const DEPLOYMENT_DOMAIN: &str = "thruput-standard-token-factory-v1";

/// Derives the deployment nonce for one creator-selected application nonce.
///
/// The tuple is hashed through the SDK's canonical CXS/XDR [`Hash`] encoding.
pub fn deployment_nonce(creator: &ContractAddress, nonce: &SHA256Hash) -> SHA256Hash {
    (DEPLOYMENT_DOMAIN, creator, nonce).hash()
}

/// Predicts the child address as if `factory` performed the deployment.
///
/// This helper requires an active contract or SDK test context because address
/// derivation is provided by a host syscall.
pub fn predicted_token(
    factory: &ContractAddress,
    creator: &ContractAddress,
    nonce: &SHA256Hash,
    token_hash: &SHA256Hash,
) -> ContractAddress {
    get_deploy_address_for_other(factory, &deployment_nonce(creator, nonce), token_hash)
}
