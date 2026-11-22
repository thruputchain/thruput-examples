#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::*;

thruput_sdk::declare_mock_contract!();

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

// ── Contract trait ───────────────────────────────────────────────────────

/// Demonstrates the `throws(A, B)` syntax for declaring multiple error types
/// on a single contract trait.
///
/// `throws` publishes the interface's error contract in its spec. It does not
/// change how a caller catches: every generated `try_*` method returns
/// `Result<T, CallError>`, where a caught exception stays an untyped
/// `RawException` to be matched by selector with `match_exn!`.
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

    /// Throws one of the SDK's own exceptions.
    fn throw_library();

    /// Calls throw_alpha_not_found() on another instance via the non-try
    /// method. The error should be forwarded through the call chain.
    fn forward_error(target: ContractAddress);

    /// Catch every outcome through one `match_exn!` in guest code.
    fn classify(target: ContractAddress, which: u32) -> u32;
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

    fn throw_library() {
        throw(LibraryExn::NonNegativeIntOverflow);
    }

    fn forward_error(target: ContractAddress) {
        // Non-try call: if the target throws, the error is forwarded
        MultiThrowsClient::new(&target).throw_alpha_not_found();
    }

    /// Catch every outcome in guest code through one `match_exn!`, and
    /// report which arm it landed in: 0 success, 1 fault, 2/3 `AlphaError`,
    /// 4 `BetaError`, 5 `LibraryExn`, 6 anything else.
    fn classify(target: ContractAddress, which: u32) -> u32 {
        let client = MultiThrowsClient::new(&target);

        let outcome = match which {
            0 => client.try_succeed().map(|_| ()),
            1 => client.try_throw_alpha_not_found(),
            2 => client.try_throw_alpha_overflow(),
            3 => client.try_throw_beta_denied(),
            _ => client.try_throw_library(),
        };

        match outcome {
            Ok(()) => 0,
            // Carries no exception, so it stays an ordinary `match` arm.
            Err(CallError::Fault(_)) => 1,
            Err(e) => match_exn!(e, {
                AlphaError::NotFound => 2,
                AlphaError::Overflow => 3,
                BetaError::Denied => 4,
                LibraryExn::NonNegativeIntOverflow => 5,
                _ => 6,
            }),
        }
    }
}
