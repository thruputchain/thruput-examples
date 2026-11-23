//! Standard token factory events.

use thruput_erc20_if::Amount;
use thruput_erc20_metadata_if::{Name, Symbol};
use thruput_sdk::{ContractAddress, Event, SHA256Hash};

/// Canonical discovery and provenance record for a factory-created token.
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct TokenCreated {
    /// Newly deployed standard token address.
    #[topic]
    pub token: ContractAddress,
    /// Immediate wallet caller that requested creation.
    #[topic]
    pub creator: ContractAddress,
    /// Token administrator selected by the creator.
    pub administrator: ContractAddress,
    /// Address receiving the initial supply.
    pub initial_holder: ContractAddress,
    /// Amount minted during initialization.
    pub initial_supply: Amount,
    /// Optional display name.
    pub name: Option<Name>,
    /// Optional display symbol.
    pub symbol: Option<Symbol>,
    /// Optional display precision.
    pub decimals: Option<u32>,
    /// Immutable token artifact hash deployed by the factory.
    pub token_code_hash: SHA256Hash,
}
