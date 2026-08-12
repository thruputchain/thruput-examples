//! Test-only wallet contract for token-factory caller checks.
//!
//! This fixture exists only for host tests and must never enter a release
//! manifest.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::*;
use standard_token_factory_if::{
    Amount, Difference, ERC20Client, Name, StandardTokenFactoryClient, Symbol,
};
use token_factory_test_if::{TokenFactoryFailingChildClient, TokenFactoryTestWallet};

sdk::declare_mock_contract!();

/// Stateless wallet fixture that forwards a caller probe.
pub struct TestWallet;

#[contract(exports = "token_factory_test_wallet_exports")]
impl TokenFactoryTestWallet for TestWallet {
    fn probe_caller(child: &ContractAddress) -> ContractAddress {
        TokenFactoryFailingChildClient::new(child).caller()
    }

    fn predict_token(factory: &ContractAddress, nonce: &SHA256Hash) -> ContractAddress {
        StandardTokenFactoryClient::new(factory).predict_token(&get_current_address(), nonce)
    }

    fn fund_token(native_token: &ContractAddress, token: &ContractAddress, amount: Amount) {
        ERC20Client::new(native_token).transfer(token, amount);
    }

    fn adjust_native_allowance(
        native_token: &ContractAddress,
        spender: &ContractAddress,
        difference: Difference,
    ) {
        ERC20Client::new(native_token).adjust_allowance(spender, difference);
    }

    fn create_token(
        factory: &ContractAddress,
        nonce: &SHA256Hash,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    ) -> ContractAddress {
        StandardTokenFactoryClient::new(factory).create_token(
            nonce,
            administrator,
            name,
            symbol,
            decimals,
            initial_holder,
            initial_supply,
        )
    }

    fn fund_and_create_token(
        native_token: &ContractAddress,
        factory: &ContractAddress,
        funding: Amount,
        nonce: &SHA256Hash,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    ) -> ContractAddress {
        let factory_client = StandardTokenFactoryClient::new(factory);
        let token = factory_client.predict_token(&get_current_address(), nonce);
        ERC20Client::new(native_token).transfer(&token, funding);
        factory_client.create_token(
            nonce,
            administrator,
            name,
            symbol,
            decimals,
            initial_holder,
            initial_supply,
        )
    }
}
