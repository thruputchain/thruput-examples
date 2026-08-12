//! Test-only child contract for token-factory host feasibility checks.
//!
//! This artifact deliberately fails and must never enter a release manifest.

#![cfg_attr(not(feature = "dev"), no_std)]

use groundhog_erc20_if::{CONTRACT_ADDR_ZERO, log_transfer_event};
use sdk::storage::*;
use sdk::*;
use standard_token_factory_if::{Amount, ERC20Error, Name, StandardTokenInitializer, Symbol};
use token_factory_test_if::*;

sdk::declare_mock_contract!();

/// State used to probe rollback and same-block exclusive writes.
#[storage]
pub struct FailingChild {
    value: Value<u64>,
}

#[contract(exports = "token_factory_failing_child_exports")]
impl TokenFactoryFailingChild for FailingChild {
    fn caller(&self) -> ContractAddress {
        get_caller()
    }

    fn initialize_failing(&mut self) {
        self.value.set_exclusive(&u64::MAX);
        log_event(&ExclusiveWrite { value: u64::MAX });
        throw(TokenFactoryFixtureError::DeliberateFailure);
    }

    fn write_exclusive(&mut self, value: u64) {
        self.value.set_exclusive(&value);
        log_event(&ExclusiveWrite { value });
    }

    fn value(&self) -> Option<u64> {
        self.value.try_get().none_if_missing()
    }
}

#[contract]
impl StandardTokenInitializer for FailingChild {
    fn initialize_from_factory(
        &mut self,
        _administrator: &ContractAddress,
        _name: Option<Name>,
        _symbol: Option<Symbol>,
        _decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    ) {
        self.value.set_exclusive(&u64::MAX);
        log_event(&ExclusiveWrite { value: u64::MAX });
        if initial_supply != 0 {
            log_transfer_event(CONTRACT_ADDR_ZERO, initial_holder, initial_supply);
        }
        throw(ERC20Error::Internal);
    }
}
