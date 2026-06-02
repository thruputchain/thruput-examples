#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::{Map, NNInt};
use sdk::*;

sdk::declare_mock_contract!();

/// Simulator fixture for NNInt-heavy positive writes.
///
/// This crate is intentionally a simulator fixture rather than a user-facing
/// example contract. The `churn` method exercises strict increments, commuting
/// increments, bounded decrements, and per-caller map entries in one call.
#[sdk::storage]
pub struct NnintStress {
    total: NNInt,
    by_caller: Map<ContractAddress, NNInt>,
}

#[contract]
impl NnintStress {
    pub fn churn(&mut self, amount: u64, refund: u64) -> u64 {
        let refund = refund.min(amount);
        let delta = amount as i128;
        let refund_delta = -(refund as i128);

        self.total.strict_inc(delta);
        self.total.inc(1);
        self.total.strict_inc(refund_delta);

        let caller = get_caller();
        let mut caller_total = self.by_caller.at_mut(&caller);
        caller_total.strict_inc(delta);
        caller_total.inc(1);
        caller_total.strict_inc(refund_delta);

        self.total.get() as u64
    }

    pub fn total(&self) -> u64 {
        self.total.try_get().unwrap_or(0) as u64
    }

    pub fn caller_total(&self) -> u64 {
        self.by_caller.at(&get_caller()).try_get().unwrap_or(0) as u64
    }
}
