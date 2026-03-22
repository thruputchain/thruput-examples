#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::*;
use thiserror::Error;

/// Maximum input to prevent excessive computation.
const MAX_FIB_INPUT: u64 = 30;

/// Error type for the Fibonacci contract.
#[derive(Error, Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
#[repr(i32)]
pub enum FibError {
    #[error("Input too large: max is {}", MAX_FIB_INPUT)]
    InputTooLarge = 1,
}

/// Event emitted after computing a Fibonacci number.
#[derive(Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
pub struct FibComputed {
    pub input: u64,
    pub result: u64,
}

static FIB_COMPUTED_TOPIC: Topic = hash_to_array!("FibComputed");

impl Event for FibComputed {
    fn num_topics(&self) -> u32 {
        1
    }

    fn topic(&self, index: u32) -> Option<TopicSrc<'_>> {
        match index {
            0 => Some(TopicSrc::Shared(&FIB_COMPUTED_TOPIC)),
            _ => None,
        }
    }
}

/// Stateless Fibonacci contract.
pub struct Fibonacci;

#[contract(throws = FibError, client = FibonacciClient)]
impl Fibonacci {
    /// Compute the nth Fibonacci number using naive recursion.
    /// Aborts if n > MAX_FIB_INPUT.
    pub fn compute(n: u64) -> u64 {
        if n > MAX_FIB_INPUT {
            // A deliberate abort (with an error) returns FibError::InputTooLarge to the caller,
            // which is visible as an InvocationFrameOutput::Abort(FibError).
            abort(&FibError::InputTooLarge);
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
