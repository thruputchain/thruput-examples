//! Test-only caller for atomic token storage top-up validation.

#![cfg_attr(not(feature = "dev"), no_std)]

use groundhog_erc20_if::{Amount, ERC20Client, ERC20Error};
use sdk::*;

sdk::declare_mock_contract!();

#[contract(client = Client, throws = ERC20Error)]
pub trait TokenFactoryTestWallet {
    fn top_up_and_transfer(
        native_token: &ContractAddress,
        token: &ContractAddress,
        receiver: &ContractAddress,
        hog_amount: Amount,
        token_amount: Amount,
    );
}

pub struct TestWallet;

#[contract]
impl TokenFactoryTestWallet for TestWallet {
    fn top_up_and_transfer(
        native_token: &ContractAddress,
        token: &ContractAddress,
        receiver: &ContractAddress,
        hog_amount: Amount,
        token_amount: Amount,
    ) {
        ERC20Client::new(native_token).transfer(token, hog_amount);
        ERC20Client::new(token).transfer(receiver, token_amount);
    }
}
