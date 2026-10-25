use fee_market::{FeeMarket, InitError};
use thruput_erc20_if::{ERC20Client, ERC20Error};
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::{Balance, Node};
use thruput_sdk::*;

#[contract_exception]
pub enum PricedCounterError {
    /// `initialize` was given a target of zero increments per block.
    ZeroTarget = 1,
    /// `initialize` was called on a counter that is already running.
    AlreadyInitialized = 2,
}

/// A counter whose increments cost an entry fee.
///
/// The fee is a `FeeMarket`'s: free while increments stay at or under the target per block, rising
/// by up to an eighth in each block that receives more, and falling back in each that receives
/// fewer. Concurrent increments never conflict -- not over the count, which is a `Balance`, and not
/// over the fee, which every increment in a block computes and records alike.
#[thruput_sdk::storage]
pub struct PricedCounter {
    value: Balance,
    fee: Node<FeeMarket>,
}

#[contract(throws(PricedCounterError, ERC20Error))]
impl PricedCounter {
    /// Start the fee, steering toward `target` increments per block. Callable once.
    pub fn initialize(&mut self, target: u32) {
        self.fee.initialize(target).unwrap_or_else(|e| {
            throw(match e {
                InitError::ZeroTarget => PricedCounterError::ZeroTarget,
                InitError::AlreadyInitialized => PricedCounterError::AlreadyInitialized,
            })
        });
    }

    /// Add `amount`, paying the current fee. Returns the fee paid.
    ///
    /// The fee is paid in native tokens, on an allowance the caller grants this contract, and
    /// stays here. A fee of zero is not collected, so no allowance is needed for it.
    pub fn increment(&mut self, amount: u64) -> u128 {
        let fee = self.fee.enter();

        if fee > 0 {
            // A fee never exceeds `fee_market::MAX_FEE`, so it fits the token's `i128`.
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
                &get_caller(),
                &get_current_address(),
                fee as i128,
            );
        }

        self.value.increase(i128::from(amount));
        fee
    }

    /// What an increment costs in this block.
    pub fn fee(&self) -> u128 {
        self.fee.quote()
    }

    pub fn get(&self) -> u64 {
        self.value.get() as u64
    }
}
