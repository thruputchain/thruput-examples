//! A factory that deploys one `nft-drop` contract for each drop.
//!
//! The creator funds the drop's storage before it exists: the drop's address
//! is predictable, so one wallet transaction can transfer native tokens to
//! that address and then call [`create_drop`](NftDropFactory::create_drop).
//! The factory checks the funding, deploys the drop, initializes it, and adds
//! it to the list.
//!
//! Creation writes the list's count, so only one drop can be created in each
//! block, as in Voting. Drops are rare; minting never touches the factory.

use nft_drop::{DropDefinition, NftDropClient};
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::{Map, NNInt, Value};
use thruput_sdk::*;

const DEPLOYMENT_DOMAIN: &str = "thruput-examples-nft-drop-factory-v1";

#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FactoryConfig {
    /// The code every drop runs.
    pub drop_code_hash: SHA256Hash,
    /// Native-token raw units a new drop needs for its own storage.
    pub base_funding: i128,
    /// Extra raw units for each token in the supply.
    pub funding_per_token: i128,
}

#[contract_exception]
pub enum FactoryError {
    AlreadyInitialized = 1,
    InvalidConfig = 2,
    InsufficientFunding = 3,
    NotFound = 4,
}

#[derive(Event, Clone, Debug)]
pub struct DropCreated {
    #[topic]
    pub drop: ContractAddress,
    #[topic]
    pub creator: ContractAddress,
    pub index: u64,
    pub supply: u32,
}

#[thruput_sdk::storage]
pub struct NftDropFactory {
    config: Value<FactoryConfig>,
    drop_count: NNInt,
    drops: Map<u64, Value<ContractAddress>>,
}

/// Each creator gets its own address space, so two creators that choose the
/// same nonce cannot collide.
fn deployment_nonce(creator: &ContractAddress, nonce: &SHA256Hash) -> SHA256Hash {
    (DEPLOYMENT_DOMAIN, creator, nonce).hash()
}

#[contract(client = NftDropFactoryClient, throws = FactoryError, emits(DropCreated))]
impl NftDropFactory {
    /// Call this in the transaction that deploys the factory.
    pub fn initialize(&mut self, config: FactoryConfig) {
        ensure(
            self.config.try_get().none_if_missing().is_none(),
            FactoryError::AlreadyInitialized,
        );
        ensure(
            config.drop_code_hash != SHA256Hash::new([0; 32])
                && config.base_funding >= 0
                && config.funding_per_token >= 0,
            FactoryError::InvalidConfig,
        );
        self.config.set_exclusive(&config);
    }

    pub fn config(&self) -> FactoryConfig {
        self.config.get()
    }

    /// The native-token raw units a drop of `supply` tokens needs.
    pub fn required_funding(&self, supply: u32) -> i128 {
        let config = self.config.get();
        config.base_funding + config.funding_per_token * i128::from(supply)
    }

    /// The address `create_drop` will use for this creator and nonce.
    pub fn predict_drop(&self, creator: &ContractAddress, nonce: &SHA256Hash) -> ContractAddress {
        get_deploy_address_for_other(
            &get_current_address(),
            &deployment_nonce(creator, nonce),
            &self.config.get().drop_code_hash,
        )
    }

    /// Deploy and initialize a drop whose predicted address already holds its
    /// required funding. The drop keeps that funding for its storage.
    pub fn create_drop(
        &mut self,
        nonce: &SHA256Hash,
        definition: DropDefinition,
    ) -> ContractAddress {
        let creator = get_caller();
        let supply = definition.supply;
        let predicted = self.predict_drop(&creator, nonce);
        ensure(
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&predicted)
                >= self.required_funding(supply),
            FactoryError::InsufficientFunding,
        );

        let drop = deploy_contract(
            &deployment_nonce(&creator, nonce),
            &self.config.get().drop_code_hash,
        );
        // An invalid definition aborts here, which rolls back the deployment.
        NftDropClient::new(&drop).initialize(&creator, definition);

        // Concurrent creations would write the same new count; the exclusive
        // write to its list entry lets only one of them land in a block.
        let index = self.drop_count();
        self.drop_count.set(i128::from(index) + 1);
        self.drops.at_mut_exclusive(&index).set(&drop);

        log_event(&DropCreated {
            drop,
            creator,
            index,
            supply,
        });
        drop
    }

    pub fn drop_count(&self) -> u64 {
        self.drop_count.try_get().none_if_missing().unwrap_or(0) as u64
    }

    pub fn drop_at(&self, index: u64) -> ContractAddress {
        self.drops
            .at(&index)
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(FactoryError::NotFound))
    }
}
