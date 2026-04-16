#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::*;

sdk::declare_mock_contract!();

// ── Error types ──────────────────────────────────────────────────────────

/// First error type — represents "alpha" category errors.
#[contract_exception]
pub enum AlphaError {
    NotFound = 1,
    Overflow = 2,
}

/// Second error type — represents "beta" category errors.
#[contract_exception]
pub enum BetaError {
    Denied = 1,
}

/// An error NOT declared in the throws list. When thrown, the client receives
/// it as an Unknown variant, which can be decoded with try_as::<SecretError>().
#[contract_exception]
pub enum SecretError {
    Secret = 1,
}

// ── Contract trait ───────────────────────────────────────────────────────

/// Demonstrates the `throws(A, B)` syntax for declaring multiple error types
/// on a single contract trait. The generated `MultiThrowsClientError` enum has
/// a variant for each declared error type, plus Library, Unknown, and Fault.
#[contract(throws(AlphaError, BetaError))]
pub trait MultiThrows {
    /// Returns 42 on success.
    fn succeed() -> u32;

    /// Throws AlphaError::NotFound.
    fn throw_alpha_not_found();

    /// Throws AlphaError::Overflow.
    fn throw_alpha_overflow();

    /// Throws BetaError::Denied.
    fn throw_beta_denied();

    /// Throws SecretError, which is NOT in the throws list.
    fn throw_undeclared();

    /// Calls throw_alpha_not_found() on another instance via the non-try
    /// method. The error should be forwarded through the call chain.
    fn forward_error(target: ContractAddress);

    /// Calls throw_undeclared() on another instance via the non-try
    /// method. The forwarded SecretError arrives as Unknown.
    fn forward_undeclared(target: ContractAddress);

    /// Panics intentionally.
    fn panics();

    /// Calls panics() on another instance. The fault propagates.
    fn forward_fault(target: ContractAddress);
}

// ── Implementation ───────────────────────────────────────────────────────

#[derive(Default)]
pub struct MultiThrowsContract;

#[contract]
impl MultiThrows for MultiThrowsContract {
    fn succeed() -> u32 {
        42
    }

    fn throw_alpha_not_found() {
        throw(AlphaError::NotFound);
    }

    fn throw_alpha_overflow() {
        throw(AlphaError::Overflow);
    }

    fn throw_beta_denied() {
        throw(BetaError::Denied);
    }

    fn throw_undeclared() {
        throw(SecretError::Secret);
    }

    fn forward_error(target: ContractAddress) {
        // Non-try call: if the target throws, the error is forwarded
        MultiThrowsClient::new(&target).throw_alpha_not_found();
    }

    fn forward_undeclared(target: ContractAddress) {
        // Non-try call: SecretError isn't in throws, forwarded as raw bytes
        MultiThrowsClient::new(&target).throw_undeclared();
    }

    fn panics() {
        panic!("intentional panic");
    }

    fn forward_fault(target: ContractAddress) {
        // Non-try call: the inner panic propagates as a fault
        MultiThrowsClient::new(&target).panics();
    }
}
