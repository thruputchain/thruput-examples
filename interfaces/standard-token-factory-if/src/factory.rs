//! Standard token factory interface and configuration.

use core::fmt;

use groundhog_erc20_if::{Amount, ERC20Error};
use groundhog_erc20_metadata_if::{Name, Symbol};
use sdk::*;

use crate::TokenCreated;

/// Immutable configuration for one standard token factory deployment.
#[contract_type]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct FactoryConfig {
    /// Hash of the only token artifact this factory may deploy.
    pub token_code_hash: SHA256Hash,
    /// Native HOG required at a predicted token address before creation.
    pub required_token_funding: Amount,
    /// Native token contract used for funding and optional fees.
    pub native_token: ContractAddress,
    /// Native HOG charged to the creator, or zero when creation is free.
    pub creation_fee: Amount,
    /// Immutable fee recipient; required only for a nonzero fee.
    pub fee_recipient: Option<ContractAddress>,
}

/// Validation and state errors produced by a standard token factory.
#[contract_exception]
#[non_exhaustive]
pub enum TokenFactoryError {
    /// The factory configuration was already written.
    AlreadyInitialized = 1,
    /// The supplied immutable factory configuration is invalid.
    InvalidConfig = 2,
    /// The requested token administration, holder, or supply is invalid.
    InvalidTokenConfig = 3,
    /// The predicted child address lacks the configured native funding.
    InsufficientTokenFunding = 4,
}

impl fmt::Display for TokenFactoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TokenFactory{:?}", self)
    }
}

/// Factory for one immutable standard token implementation.
#[contract(
    client = StandardTokenFactoryClient,
    throws(TokenFactoryError, ERC20Error),
    emits(TokenCreated)
)]
pub trait StandardTokenFactory {
    /// Writes immutable factory configuration exactly once.
    fn initialize(&mut self, config: FactoryConfig);

    /// Deploys and initializes a token for the immediate caller.
    #[expect(
        clippy::too_many_arguments,
        reason = "the specification fixes the public create_token ABI"
    )]
    fn create_token(
        &mut self,
        nonce: &SHA256Hash,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    ) -> ContractAddress;

    /// Predicts the token address for `creator` and its application nonce.
    fn predict_token(&self, creator: &ContractAddress, nonce: &SHA256Hash) -> ContractAddress;

    /// Returns the native HOG required at a predicted token address.
    fn required_token_funding(&self) -> Amount;

    /// Returns the immutable native HOG creation fee.
    fn creation_fee(&self) -> Amount;

    /// Returns the complete immutable factory configuration.
    fn config(&self) -> FactoryConfig;
}
