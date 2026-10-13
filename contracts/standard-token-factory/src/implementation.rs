use sdk::storage::Value;
use sdk::*;
use standard_token_factory_if::{
    Amount, FactoryConfig, Name, StandardTokenFactory, StandardTokenInitializerClient, Symbol,
    TokenCreated, TokenFactoryError, deployment_nonce, predicted_token,
};
use thruput_erc20_if::{CONTRACT_ADDR_ZERO, ERC20Client};

#[sdk::storage]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct StandardTokenFactoryContract {
    config: Value<FactoryConfig>,
}

impl StandardTokenFactoryContract {
    fn validate_config(config: &FactoryConfig) {
        let valid_fee = match (config.creation_fee, config.fee_recipient) {
            (0, None) => true,
            (0, Some(_)) | (_, None) => false,
            (_, Some(recipient)) => {
                recipient != *CONTRACT_ADDR_ZERO && recipient != get_current_address()
            }
        };

        ensure(
            config.token_code_hash != SHA256Hash::new([0; 32])
                && config.native_token != *CONTRACT_ADDR_ZERO
                && config.required_token_funding > 0
                && config.creation_fee >= 0
                && valid_fee,
            TokenFactoryError::InvalidConfig,
        );
    }

    fn token_address(
        &self,
        config: &FactoryConfig,
        creator: &ContractAddress,
        nonce: &SHA256Hash,
    ) -> ContractAddress {
        predicted_token(
            &get_current_address(),
            creator,
            nonce,
            &config.token_code_hash,
        )
    }
}

#[contract(exports = "standard_token_factory_exports")]
impl StandardTokenFactory for StandardTokenFactoryContract {
    fn initialize(&mut self, config: FactoryConfig) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(TokenFactoryError::AlreadyInitialized);
        }

        Self::validate_config(&config);
        self.config.set_exclusive(&config);
    }

    fn create_token(
        &mut self,
        nonce: &SHA256Hash,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    ) -> ContractAddress {
        let creator = get_caller();
        ensure(
            *administrator != *CONTRACT_ADDR_ZERO
                && *initial_holder != *CONTRACT_ADDR_ZERO
                && initial_supply >= 0,
            TokenFactoryError::InvalidTokenConfig,
        );

        let config = self.config.get();
        let predicted = self.token_address(&config, &creator, nonce);
        let native_token = ERC20Client::new(&config.native_token);
        ensure(
            native_token.get_balance_of(&predicted) >= config.required_token_funding,
            TokenFactoryError::InsufficientTokenFunding,
        );

        if let Some(fee_recipient) = config.fee_recipient {
            native_token.transfer_from(&creator, &fee_recipient, config.creation_fee);
        }

        let token = deploy_contract(&deployment_nonce(&creator, nonce), &config.token_code_hash);
        ensure(token == predicted, TokenFactoryError::InvalidConfig);

        StandardTokenInitializerClient::new(&token).initialize_from_factory(
            administrator,
            name.clone(),
            symbol.clone(),
            decimals,
            initial_holder,
            initial_supply,
        );

        log_event(&TokenCreated {
            token,
            creator,
            administrator: *administrator,
            initial_holder: *initial_holder,
            initial_supply,
            name,
            symbol,
            decimals,
            token_code_hash: config.token_code_hash,
        });

        token
    }

    fn predict_token(&self, creator: &ContractAddress, nonce: &SHA256Hash) -> ContractAddress {
        self.token_address(&self.config.get(), creator, nonce)
    }

    fn required_token_funding(&self) -> Amount {
        self.config.get().required_token_funding
    }

    fn creation_fee(&self) -> Amount {
        self.config.get().creation_fee
    }

    fn config(&self) -> FactoryConfig {
        self.config.get()
    }
}
