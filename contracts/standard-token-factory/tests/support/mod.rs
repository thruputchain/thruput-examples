#![allow(dead_code)]

use groundhog_erc20_if::ERC20Client;
use sdk::*;
use standard_token_factory::{Amount, FactoryConfig, Name, StandardTokenFactoryClient, Symbol};
use token_factory_test_if::TokenFactoryTestWalletClient;

pub const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
pub const ADMIN: ContractAddress = ContractAddress::new([0x20; 32]);
pub const HOLDER: ContractAddress = ContractAddress::new([0x30; 32]);
pub const OTHER_HOLDER: ContractAddress = ContractAddress::new([0x31; 32]);
pub const TREASURY: ContractAddress = ContractAddress::new([0x40; 32]);
pub const FACTORY_NONCE: SHA256Hash = SHA256Hash::new([0x51; 32]);
pub const NATIVE_NONCE: SHA256Hash = SHA256Hash::new([0x52; 32]);
pub const WALLET_NONCE: SHA256Hash = SHA256Hash::new([0x53; 32]);
pub const TOKEN_NONCE: SHA256Hash = SHA256Hash::new([0x61; 32]);
pub const REQUIRED_FUNDING: Amount = 100;
pub const FEE: Amount = 25;

#[derive(Copy, Clone)]
pub enum ChildArtifact {
    Standard,
    Failing,
    Unavailable,
}

#[derive(Clone)]
pub struct Creation {
    pub nonce: SHA256Hash,
    pub administrator: ContractAddress,
    pub name: Option<Name>,
    pub symbol: Option<Symbol>,
    pub decimals: Option<u32>,
    pub initial_holder: ContractAddress,
    pub initial_supply: Amount,
}

impl Default for Creation {
    fn default() -> Self {
        Self {
            nonce: TOKEN_NONCE,
            administrator: ADMIN,
            name: Some("Standard Token".try_into().unwrap()),
            symbol: Some("STD".try_into().unwrap()),
            decimals: Some(9),
            initial_holder: HOLDER,
            initial_supply: 1_000,
        }
    }
}

pub struct Setup {
    pub env: TestEnvironmentHandle,
    pub factory: ContractAddress,
    pub wallet: ContractAddress,
    pub native_token: ContractAddress,
    pub token_hash: SHA256Hash,
    pub fee: Amount,
    pub fee_recipient: Option<ContractAddress>,
}

#[derive(Debug, PartialEq, Eq, ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
pub struct NativeState {
    pub wallet: Amount,
    pub predicted: Amount,
    pub treasury: Amount,
    pub factory: Amount,
    pub allowance: Amount,
}

pub fn setup(fee: Amount, recipient: Option<ContractAddress>, child: ChildArtifact) -> Setup {
    let env = TestEnvironment::no_cost();
    let native_hash = *standard_token::register_mock_contract(&env).as_hash();
    let token_hash = match child {
        ChildArtifact::Standard => native_hash,
        ChildArtifact::Failing => {
            *token_factory_failing_child::register_mock_contract(&env).as_hash()
        }
        ChildArtifact::Unavailable => SHA256Hash::new([0xee; 32]),
    };
    let factory_hash = *standard_token_factory::register_mock_contract(&env).as_hash();
    let wallet_hash = *token_factory_test_wallet::register_mock_contract(&env).as_hash();

    let result = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let native_token = deploy_contract(&NATIVE_NONCE, &native_hash);
            let wallet = deploy_contract(&WALLET_NONCE, &wallet_hash);
            let factory = deploy_contract(&FACTORY_NONCE, &factory_hash);

            let native = ERC20Client::new(&native_token);
            native.initialize(&ROOT);
            native.mint(&ROOT, 1_000_000);
            native.transfer(&wallet, 100_000);

            StandardTokenFactoryClient::new(&factory).initialize(FactoryConfig {
                token_code_hash: token_hash,
                required_token_funding: REQUIRED_FUNDING,
                native_token,
                creation_fee: fee,
                fee_recipient: recipient,
            });
            (native_token, wallet, factory)
        })
    });
    result.assert_success();
    let (native_token, wallet, factory) = result.assert_return_as();
    env.advance_block();

    Setup {
        env,
        factory,
        wallet,
        native_token,
        token_hash,
        fee,
        fee_recipient: recipient,
    }
}

pub fn predict(setup: &Setup, creation: &Creation) -> ContractAddress {
    let wallet = setup.wallet;
    let factory = setup.factory;
    let nonce = creation.nonce;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| TokenFactoryTestWalletClient::new(&wallet).predict_token(&factory, &nonce))
    });
    result.assert_success();
    result.assert_return_as()
}

pub fn fund(setup: &Setup, predicted: &ContractAddress, amount: Amount) {
    let wallet = setup.wallet;
    let native_token = setup.native_token;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet).fund_token(&native_token, predicted, amount)
        })
    });
    result.assert_success();
    setup.env.advance_block();
}

pub fn adjust_allowance(setup: &Setup, difference: i128) {
    let wallet = setup.wallet;
    let native_token = setup.native_token;
    let factory = setup.factory;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet).adjust_native_allowance(
                &native_token,
                &factory,
                difference,
            )
        })
    });
    result.assert_success();
    setup.env.advance_block();
}

pub fn create(setup: &Setup, creation: &Creation) -> TransactResult {
    let wallet = setup.wallet;
    let factory = setup.factory;
    let creation = creation.clone();
    setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet).create_token(
                &factory,
                &creation.nonce,
                &creation.administrator,
                creation.name,
                creation.symbol,
                creation.decimals,
                &creation.initial_holder,
                creation.initial_supply,
            )
        })
    })
}

pub fn fund_and_create(setup: &Setup, creation: &Creation, funding: Amount) -> TransactResult {
    let wallet = setup.wallet;
    let native_token = setup.native_token;
    let factory = setup.factory;
    let creation = creation.clone();
    setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet).fund_and_create_token(
                &native_token,
                &factory,
                funding,
                &creation.nonce,
                &creation.administrator,
                creation.name,
                creation.symbol,
                creation.decimals,
                &creation.initial_holder,
                creation.initial_supply,
            )
        })
    })
}

pub fn native_state(setup: &Setup, predicted: &ContractAddress) -> NativeState {
    let native_token = setup.native_token;
    let wallet = setup.wallet;
    let factory = setup.factory;
    let predicted = *predicted;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let native = ERC20Client::new(&native_token);
            NativeState {
                wallet: native.get_balance_of(&wallet),
                predicted: native.get_balance_of(&predicted),
                treasury: native.get_balance_of(&TREASURY),
                factory: native.get_balance_of(&factory),
                allowance: native.allowance(&wallet, &factory),
            }
        })
    });
    result.assert_success();
    result.assert_return_as()
}
