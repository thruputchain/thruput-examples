#![cfg_attr(not(feature = "dev"), no_std)]

use error_handling_callee::{CalleeError, ErrorHandlingCalleeClient};
use sdk::*;
use thiserror::Error;

/// Error type for the caller contract. Exists to satisfy the #[contract] macro;
/// the caller never aborts — it catches everything.
#[derive(Error, Debug, Clone, PartialEq, ReadXDR, WriteXDR)]
#[repr(i32)]
pub enum CallerError {
    #[error("Unexpected result")]
    UnexpectedResult = 1,
}

/// Contract demonstrating comprehensive cross-contract error handling.
pub struct ErrorHandlingCaller;

#[contract(throws = CallerError, client = ErrorHandlingCallerClient)]
impl ErrorHandlingCaller {
    /// Happy path: call succeed on the callee, return the result.
    pub fn call_succeed(callee: &ContractAddress, data: u64) -> u64 {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        client.succeed(data)
    }

    /// Call the callee's abort_with_error, catch the Abort, verify it contains
    /// CalleeError::Deliberate, and return true.
    pub fn call_and_catch_abort(callee: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        match client.try_abort_with_error() {
            Err(CallError::Abort(ref cross_exn)) => cross_exn
                .as_contract_exn()
                .is_some_and(|e| *e == CalleeError::Deliberate),
            _ => false,
        }
    }

    /// Call the callee's fault method, catch the Fault, and return true.
    pub fn call_and_catch_fault(callee: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        match client.try_fault() {
            Err(CallError::Fault(_)) => true,
            _ => false,
        }
    }

    /// Call the callee's spin method with a gas limit. If the callee runs out of gas,
    /// catch the Fault and return true.
    pub fn call_with_gas_limit(callee: &ContractAddress, iterations: u32, gas_limit: u64) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        match client.with_gas_limit(gas_limit).try_spin(iterations) {
            Err(CallError::Fault(_)) => true,
            _ => false,
        }
    }
}
