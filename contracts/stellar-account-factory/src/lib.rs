//! Deploys Stellar-classic accounts at an address that is a function of the
//! master key, and initializes each one before its own frame ends, so no
//! account is ever observable uninitialized.
//!
//! hogd charges a deployment's storage to the deployed address, so the
//! predicted address must already hold `required_funding` of the native
//! token. That is Stellar's starting balance: a creator pays it to
//! `address_of(master_key)` and then calls `create_account`.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

use groundhog_erc20_if::{CONTRACT_ADDR_ZERO, ERC20Client};
use sdk::storage::Value;
use sdk::*;
pub use stellar_account_factory_if::{
    AccountCreated, AccountFactoryError, FactoryConfig, StellarAccountFactory,
    StellarAccountFactoryClient, StellarAccountInitializerClient, account_address,
    deployment_nonce,
};

#[sdk::storage]
pub struct StellarAccountFactoryContract {
    config: Value<FactoryConfig>,
}

impl StellarAccountFactoryContract {
    fn predicted(config: &FactoryConfig, master_key: &Ed25519PublicKey) -> ContractAddress {
        account_address(
            &get_current_address(),
            &config.account_code_hash,
            master_key,
        )
    }
}

#[contract]
impl StellarAccountFactory for StellarAccountFactoryContract {
    fn initialize(&mut self, config: FactoryConfig) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(AccountFactoryError::AlreadyInitialized);
        }
        ensure(
            config.account_code_hash != SHA256Hash::new([0; 32])
                && config.native_token != *CONTRACT_ADDR_ZERO
                && config.required_funding >= 1,
            AccountFactoryError::InvalidConfig,
        );
        self.config.set_exclusive(&config);
    }

    fn create_account(&mut self, master_key: &Ed25519PublicKey) -> ContractAddress {
        let config = self.config.get();
        let predicted = Self::predicted(&config, master_key);
        ensure(
            ERC20Client::new(&config.native_token).get_balance_of(&predicted)
                >= config.required_funding,
            AccountFactoryError::InsufficientFunding,
        );

        let account = deploy_contract(&deployment_nonce(master_key), &config.account_code_hash);
        ensure(account == predicted, AccountFactoryError::AddressMismatch);
        StellarAccountInitializerClient::new(&account).initialize(master_key);

        log_event(&AccountCreated {
            account,
            master_key: *master_key,
        });
        account
    }

    fn address_of(&self, master_key: &Ed25519PublicKey) -> ContractAddress {
        Self::predicted(&self.config.get(), master_key)
    }

    fn config(&self) -> FactoryConfig {
        self.config.get()
    }
}
