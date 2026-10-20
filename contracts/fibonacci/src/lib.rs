#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::*;

/// Maximum input to prevent excessive computation.
const MAX_FIB_INPUT: u64 = 30;

thruput_sdk::declare_mock_contract!();

/// Error type for the Fibonacci contract.
#[contract_exception]
pub enum FibError {
    InputTooLarge = 1,
}

/// Event emitted after computing a Fibonacci number.
#[derive(Event)]
pub struct FibComputed {
    pub input: u64,
    pub result: u64,
}

/// Stateless Fibonacci contract.
pub struct Fibonacci;

#[contract(throws = FibError, emits(FibComputed))]
impl Fibonacci {
    /// Compute the nth Fibonacci number using naive recursion.
    /// Throws if n > MAX_FIB_INPUT.
    pub fn compute(n: u64) -> u64 {
        if n > MAX_FIB_INPUT {
            throw(FibError::InputTooLarge);
        }

        let result = fib(n);

        log_event(&FibComputed { input: n, result });

        result
    }
}

fn fib(n: u64) -> u64 {
    match n {
        0 => 0,
        1 => 1,
        _ => fib(n - 1) + fib(n - 2),
    }
}
