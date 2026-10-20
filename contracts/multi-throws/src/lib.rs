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

/// An error NOT declared in the throws list. A caller still catches it as a
/// peer of the declared errors: an exception is self-describing on the wire,
/// so its selector identifies the type independently of what any interface
/// declared it `throws`.
#[contract_exception]
pub enum SecretError {
    Secret = 1,
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

    /// Throws SecretError, which is NOT in the throws list.
    fn throw_undeclared();

    /// Throws one of the SDK's own exceptions.
    fn throw_library();

    /// Calls throw_alpha_not_found() on another instance via the non-try
    /// method. The error should be forwarded through the call chain.
    fn forward_error(target: ContractAddress);

    /// Calls throw_undeclared() on another instance via the non-try
    /// method. The forwarded SecretError keeps its selector.
    fn forward_undeclared(target: ContractAddress);

    /// Panics intentionally.
    fn panics();

    /// Calls panics() on another instance. The fault propagates.
    fn forward_fault(target: ContractAddress);

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

    fn throw_undeclared() {
        throw(SecretError::Secret);
    }

    fn throw_library() {
        throw(LibraryExn::NonNegativeIntOverflow);
    }

    fn forward_error(target: ContractAddress) {
        // Non-try call: if the target throws, the error is forwarded
        MultiThrowsClient::new(&target).throw_alpha_not_found();
    }

    fn forward_undeclared(target: ContractAddress) {
        // Non-try call: SecretError isn't in throws, forwarded as raw bytes
        MultiThrowsClient::new(&target).throw_undeclared();
    }

    /// Catch every outcome in guest code through one `match_exn!`, and
    /// report which arm it landed in: 0 success, 1 fault, 2/3 `AlphaError`,
    /// 4 `BetaError`, 5 `SecretError`, 6 `LibraryExn`, 7 anything else.
    fn classify(target: ContractAddress, which: u32) -> u32 {
        let client = MultiThrowsClient::new(&target);

        let outcome = match which {
            0 => client.try_succeed().map(|_| ()),
            1 => client.try_throw_alpha_not_found(),
            2 => client.try_throw_alpha_overflow(),
            3 => client.try_throw_beta_denied(),
            4 => client.try_throw_undeclared(),
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
                // Undeclared by this interface; still a peer here.
                SecretError::Secret => 5,
                LibraryExn::NonNegativeIntOverflow => 6,
                _ => 7,
            }),
        }
    }

    fn panics() {
        panic!("intentional panic");
    }

    fn forward_fault(target: ContractAddress) {
        // Non-try call: the inner panic propagates as a fault
        MultiThrowsClient::new(&target).panics();
    }
}
