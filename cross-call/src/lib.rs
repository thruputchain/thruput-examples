#![cfg_attr(not(feature = "dev"), no_std)]

use fibonacci::{FibError, FibonacciClient, FibonacciClientError};
use sdk::*;

/// Error type for the cross-call contract.
#[contract_error]
pub enum CrossCallError {
    FibCallFailed = 1,
    Requested = 2,
}

/// Event emitted when a cross-call succeeds.
#[derive(Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
pub struct CrossCallCompleted {
    pub input: u64,
    pub result: u64,
}

static CROSS_CALL_COMPLETED_TOPIC: Topic = hash_to_array!("CrossCallCompleted");

impl Event for CrossCallCompleted {
    fn num_topics(&self) -> u32 {
        1
    }

    fn topic(&self, index: u32) -> Option<TopicSrc<'_>> {
        match index {
            0 => Some(TopicSrc::Shared(&CROSS_CALL_COMPLETED_TOPIC)),
            _ => None,
        }
    }
}

/// Stateless contract demonstrating cross-contract call patterns.
pub struct CrossCall;

#[contract(throws = CrossCallError, client = CrossCallClient)]
impl CrossCall {
    /// Call fibonacci and return the result. Panics on failure.
    pub fn call_fib(fib_address: &ContractAddress, n: u64) -> u64 {
        let mut fib = FibonacciClient::new(fib_address);
        let result = fib.compute(n);
        log_event(&CrossCallCompleted { input: n, result });
        result
    }

    /// Call fibonacci using try_*, returning the result or throwing
    /// CrossCallError::FibCallFailed on any error.
    pub fn call_fib_or_fail(fib_address: &ContractAddress, n: u64) -> u64 {
        let mut fib = FibonacciClient::new(fib_address);
        let result = fib.try_compute(n).or_throw(CrossCallError::FibCallFailed);
        log_event(&CrossCallCompleted { input: n, result });
        result
    }

    /// Call fibonacci with a value that will cause it to throw InputTooLarge,
    /// then catch the error and return true if it was the expected error.
    pub fn call_fib_and_catch_error(fib_address: &ContractAddress) -> bool {
        let mut fib = FibonacciClient::new(fib_address);
        matches!(
            fib.try_compute(999),
            Err(FibonacciClientError::FibError(FibError::InputTooLarge))
        )
    }
}
