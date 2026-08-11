//! Test-only child contract for token-factory host feasibility checks.
//!
//! This artifact deliberately fails and must never enter a release manifest.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::*;
use sdk::*;
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
