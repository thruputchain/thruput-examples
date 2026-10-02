//! A `u128`-facing view of an ERC20 client.
//!
//! The pair counts in `u128` (see `swap_if::Amount`); the token interface
//! counts in `i128`, never negative on the wire. These tests reason in the
//! pair's terms, so the conversion happens here, once.

use groundhog_erc20_if::ERC20Client;
use sdk::ContractAddress;

pub struct TokenClient(ERC20Client);

fn amount(value: i128) -> u128 {
    u128::try_from(value).expect("token amounts are non-negative")
}

fn token_amount(value: u128) -> i128 {
    i128::try_from(value).expect("amount fits the token's i128")
}

impl TokenClient {
    pub fn new(address: &ContractAddress) -> Self {
        Self(ERC20Client::new(address))
    }

    pub fn initialize(&self, administrator: &ContractAddress) {
        self.0.initialize(administrator)
    }

    pub fn get_balance(&self) -> u128 {
        amount(self.0.get_balance())
    }

    pub fn get_balance_of(&self, owner: &ContractAddress) -> u128 {
        amount(self.0.get_balance_of(owner))
    }

    pub fn allowance(&self, owner: &ContractAddress, spender: &ContractAddress) -> u128 {
        amount(self.0.allowance(owner, spender))
    }

    pub fn total_supply(&self) -> u128 {
        amount(self.0.total_supply())
    }

    pub fn transfer(&self, receiver: &ContractAddress, value: u128) {
        self.0.transfer(receiver, token_amount(value))
    }

    pub fn transfer_from(&self, owner: &ContractAddress, receiver: &ContractAddress, value: u128) {
        self.0.transfer_from(owner, receiver, token_amount(value))
    }

    pub fn mint(&self, receiver: &ContractAddress, value: u128) {
        self.0.mint(receiver, token_amount(value))
    }

    pub fn adjust_allowance(&self, spender: &ContractAddress, difference: i128) {
        self.0.adjust_allowance(spender, difference)
    }
}
