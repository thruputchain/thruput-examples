//! Test-only initializer that writes state and then fails.

#![cfg_attr(not(feature = "dev"), no_std)]

use standard_token_factory_if::{Amount, Name, StandardTokenInitializer, Symbol};
use thruput_erc20_if::ERC20Error;
use thruput_sdk::storage::Value;
use thruput_sdk::*;

thruput_sdk::declare_mock_contract!();

#[derive(Event)]
struct TentativeWrite {
    value: u64,
}

#[storage]
pub struct FailingChild {
    value: Value<u64>,
}

#[contract]
impl StandardTokenInitializer for FailingChild {
    fn initialize_from_factory(
        &mut self,
        _administrator: &ContractAddress,
        _name: Option<Name>,
        _symbol: Option<Symbol>,
        _decimals: Option<u32>,
        _initial_holder: &ContractAddress,
        _initial_supply: Amount,
    ) {
        self.value.set_exclusive(&u64::MAX);
        log_event(&TentativeWrite { value: u64::MAX });
        throw(ERC20Error::Internal);
    }
}
