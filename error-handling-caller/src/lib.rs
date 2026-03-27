#![cfg_attr(not(feature = "dev"), no_std)]

use error_handling_callee::{
    CalleeError, ErrorHandlingCalleeClient, ErrorHandlingCalleeClientError,
};
use sdk::*;

/// Error type for the caller contract. Exists to satisfy the #[contract] macro;
/// the caller never throws — it catches everything.
#[contract_error]
pub enum CallerError {
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

    /// Call the callee's throw_error, catch the error, verify it is
    /// CalleeError::Deliberate, and return true.
    pub fn call_and_catch_error(callee: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        matches!(
            client.try_throw_error(),
            Err(ErrorHandlingCalleeClientError::CalleeError(
                CalleeError::Deliberate
            ))
        )
    }

    /// Call the callee's fault method, catch the Fault, and return true.
    pub fn call_and_catch_fault(callee: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        matches!(
            client.try_fault(),
            Err(ErrorHandlingCalleeClientError::Fault(_))
        )
    }

    /// Call the callee's spin method with a gas limit. If the callee runs out of gas,
    /// catch the Fault and return true.
    pub fn call_with_gas_limit(callee: &ContractAddress, iterations: u32, gas_limit: u64) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(callee);
        matches!(
            client.with_gas_limit(gas_limit).try_spin(iterations),
            Err(ErrorHandlingCalleeClientError::Fault(_))
        )
    }

    /// Call try_succeed on an address where no contract is deployed.
    /// Catches the resulting error and returns true.
    pub fn call_nonexistent_address() -> bool {
        let fake_addr: ContractAddress = [0xFFu8; 32].into();
        let mut client = ErrorHandlingCalleeClient::new(&fake_addr);
        client.try_succeed(42).is_err()
    }

    /// Point an ErrorHandlingCalleeClient at a fibonacci contract and call try_succeed.
    /// The fibonacci contract doesn't have a `succeed` method, so this should fail.
    /// Catches the resulting error and returns true.
    pub fn call_wrong_contract(fib_address: &ContractAddress) -> bool {
        let mut client = ErrorHandlingCalleeClient::new(fib_address);
        client.try_succeed(42).is_err()
    }
}
