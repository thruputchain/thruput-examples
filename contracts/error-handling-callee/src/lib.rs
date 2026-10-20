#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::*;

thruput_sdk::declare_mock_contract!();

/// Error type for the callee contract.
#[contract_exception]
pub enum CalleeError {
    Deliberate = 1,
}

/// Stateless contract that produces various error conditions.
pub struct ErrorHandlingCallee;

#[contract(throws = CalleeError)]
impl ErrorHandlingCallee {
    /// Return the input value successfully.
    pub fn succeed(data: u64) -> u64 {
        data
    }

    /// Throw a typed error.
    pub fn throw_error() -> u64 {
        throw(CalleeError::Deliberate);
    }

    /// Panic to trigger a VM fault.
    pub fn fault() -> u64 {
        panic!("deliberate fault");
    }

    /// Burn gas by repeatedly hashing. Returns the iteration count if it completes.
    pub fn spin(iterations: u32) -> u32 {
        let mut hash = thruput_sdk::crypto::sha256(b"seed");
        for _ in 1..iterations {
            hash = thruput_sdk::crypto::sha256(hash.as_slice());
        }
        // Use hash to prevent the loop from being optimized away
        let _ = hash;
        iterations
    }
}
