//! Shared interfaces and deterministic derivation for Stellar-classic accounts.
//!
//! ABI definitions only: the account and its factory implement these traits
//! without depending on each other. A Stellar `G...` key maps to exactly one
//! account address per factory, computed by [`account_address`].

#![cfg_attr(not(feature = "dev"), no_std)]

pub use thruput_erc20_if::Amount;
use thruput_sdk::*;
pub use thruput_sdk::{ContractAddress, Ed25519PublicKey, SHA256Hash};

/// Immutable configuration for one account factory deployment.
#[contract_type]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct FactoryConfig {
    /// Hash of the only account artifact this factory may deploy.
    pub account_code_hash: SHA256Hash,
    /// Native token contract used to check a new account's starting balance.
    pub native_token: ContractAddress,
    /// Native-token amount an account address must hold before it can be created:
    /// Stellar's starting balance, and where hogd's deployment storage charge
    /// lands.
    pub required_funding: Amount,
}

/// Why the factory refused.
#[contract_exception]
#[non_exhaustive]
#[cfg_attr(feature = "dev", derive(thiserror::Error))]
pub enum AccountFactoryError {
    #[cfg_attr(feature = "dev", error("Factory already initialized"))]
    AlreadyInitialized = 1,
    #[cfg_attr(feature = "dev", error("Invalid factory configuration"))]
    InvalidConfig = 2,
    #[cfg_attr(
        feature = "dev",
        error("Predicted account address lacks the required funding")
    )]
    InsufficientFunding = 3,
    #[cfg_attr(feature = "dev", error("Deployed address differs from the prediction"))]
    AddressMismatch = 4,
}

/// Why an account refused to initialize.
#[contract_exception]
#[non_exhaustive]
#[cfg_attr(feature = "dev", derive(thiserror::Error))]
pub enum AccountInitError {
    #[cfg_attr(feature = "dev", error("Account already initialized"))]
    AlreadyInitialized = 1,
}

/// Emitted once per created account: the address and the master key it answers to.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct AccountCreated {
    #[topic]
    pub account: ContractAddress,
    pub master_key: Ed25519PublicKey,
}

/// Deterministic deployment of Stellar-classic accounts.
#[contract(
    client = StellarAccountFactoryClient,
    throws = AccountFactoryError,
    emits(AccountCreated)
)]
pub trait StellarAccountFactory {
    /// Writes the immutable configuration exactly once.
    fn initialize(&mut self, config: FactoryConfig);

    /// Deploys and initializes the account for `master_key` at
    /// [`address_of`](Self::address_of). The predicted address must already
    /// hold `required_funding` of the native token.
    fn create_account(&mut self, master_key: &Ed25519PublicKey) -> ContractAddress;

    /// The address `create_account(master_key)` deploys to.
    fn address_of(&self, master_key: &Ed25519PublicKey) -> ContractAddress;

    /// The immutable configuration.
    fn config(&self) -> FactoryConfig;
}

/// The one-shot initializer the factory calls in its own frame.
#[contract(client = StellarAccountInitializerClient, throws = AccountInitError)]
pub trait StellarAccountInitializer {
    /// Register `master_key` at slot 0 with weight 1, set every threshold to 1.
    fn initialize(&mut self, master_key: &Ed25519PublicKey);
}

const DEPLOYMENT_DOMAIN: &str = "thruput-stellar-account-factory-v1";

/// The deployment nonce for `master_key`: a domain-tagged hash, so the same
/// key under a different factory version lands elsewhere.
pub fn deployment_nonce(master_key: &Ed25519PublicKey) -> SHA256Hash {
    (DEPLOYMENT_DOMAIN, master_key).hash()
}

/// The account address for `master_key` as if `factory` performed the
/// deployment. Needs a contract or SDK test context: address derivation is a
/// host syscall.
pub fn account_address(
    factory: &ContractAddress,
    account_code_hash: &SHA256Hash,
    master_key: &Ed25519PublicKey,
) -> ContractAddress {
    get_deploy_address_for_other(factory, &deployment_nonce(master_key), account_code_hash)
}

/// [`account_address`] without a host: the same `deployment_nonce`
/// (computed here with the same CXS encoding and an in-process sha256, since
/// the SDK's hash is a syscall) and the same deployment-address preimage as
/// `thruput_signing::derive_deploy_address`. For clients and tests that
/// have no contract context.
#[cfg(feature = "dev")]
pub fn account_address_offchain(
    factory: &ContractAddress,
    account_code_hash: &SHA256Hash,
    master_key: &Ed25519PublicKey,
) -> ContractAddress {
    use sha2::{Digest, Sha256};
    let nonce_preimage = thruput_sdk::xdr::cxs::encode(&(DEPLOYMENT_DOMAIN, master_key))
        .expect("encoding the nonce preimage");
    let nonce: [u8; 32] = Sha256::digest(nonce_preimage).into();
    thruput_signing::derive_deploy_address(factory, &SHA256Hash::new(nonce), account_code_hash)
        .expect("encoding the deployment preimage")
}
