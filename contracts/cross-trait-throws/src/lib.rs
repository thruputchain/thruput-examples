//! Catching an error that a *different* interface declared.
//!
//! One contract, [`PausableLedger`], implements two interfaces, each with its
//! own `throws` type:
//!
//! - [`Ledger`] — deposits and withdrawals, `throws = LedgerError`;
//! - [`Pausable`] — an operator halt switch, `throws = PauseError`.
//!
//! The interesting case is where the two meet. [`Ledger::withdraw`] refuses
//! to move funds while the ledger is paused, and the error it throws to say
//! so is [`PauseError::EnforcedPause`] — which belongs to `Pausable`, not to
//! `Ledger`. A caller holding a `LedgerClient` therefore meets an error that
//! the interface it called never declared.
//!
//! That caller does not need a special case for it. A Groundhog exception is
//! self-describing on the wire — `[CXS(selector)][payload]` — and the
//! selector identifies the type independently of any interface's `throws`
//! list, so [`match_exn!`](sdk::match_exn) matches the declared error and the
//! peer interface's error side by side, as peers:
//!
//! ```ignore
//! match ledger.try_withdraw(amount) {
//!     Ok(()) => { /* ... */ }
//!     Err(CallError::Fault(_)) => { /* ... */ }
//!     Err(e) => match_exn!(e, {
//!         LedgerError::InsufficientFunds { .. } => { /* declared by Ledger */ }
//!         PauseError::EnforcedPause           => { /* declared by Pausable */ }
//!         _ => e.re_throw(),
//!     }),
//! }
//! ```
//!
//! [`PausableLedger::withdraw_from`] runs exactly that dispatch in guest
//! code, which is where a real caller does it; `tests/test.rs` also shows the
//! same catch from the caller's side.
//!
//! `throws` is not what makes an error catchable. It publishes an interface's
//! error contract in its spec — worth declaring, and what tooling reads — but
//! the caller's ability to decode comes from the selector on the wire.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::{Map, Value};
use sdk::*;

sdk::declare_mock_contract!();

// ── The Ledger interface ─────────────────────────────────────────────────

/// Errors declared by the [`Ledger`] interface.
#[contract_exception]
pub enum LedgerError {
    /// The account holds less than the amount asked for.
    InsufficientFunds { held: u64, requested: u64 } = 1,
    /// A deposit or withdrawal of zero, which is always a caller mistake.
    ZeroAmount = 2,
}

/// A minimal balance ledger.
#[contract(client = LedgerClient, throws = LedgerError)]
pub trait Ledger {
    /// Credit the caller's account.
    fn deposit(&mut self, amount: u64);

    /// Debit the caller's account.
    ///
    /// Throws [`LedgerError::InsufficientFunds`] when the balance is too
    /// small — and [`PauseError::EnforcedPause`], from the peer interface,
    /// when the ledger is paused.
    fn withdraw(&mut self, amount: u64);

    /// The caller's balance. Unknown accounts read as zero.
    fn balance(&self) -> u64;
}

// ── The Pausable interface ───────────────────────────────────────────────

/// Errors declared by the [`Pausable`] interface — a distinct type, on a
/// distinct interface, with its own selector.
#[contract_exception]
pub enum PauseError {
    /// The operation is refused because the contract is paused.
    EnforcedPause = 1,
    /// `unpause` was called while the contract was already running.
    ExpectedPause = 2,
    /// Only the operator set at initialization may pause or unpause.
    NotOperator = 3,
}

/// An operator-controlled halt switch.
#[contract(client = PausableClient, throws = PauseError)]
pub trait Pausable {
    fn pause(&mut self);
    fn unpause(&mut self);
    fn paused(&self) -> bool;
}

// ── The contract implementing both ───────────────────────────────────────

/// One storage struct behind both interfaces.
#[sdk::storage]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct PausableLedger {
    operator: Value<ContractAddress>,
    paused: Value<bool>,
    balances: Map<ContractAddress, Value<u64>>,
}

impl PausableLedger {
    fn _paused(&self) -> bool {
        self.paused.try_get().none_if_missing().unwrap_or(false)
    }

    fn _balance_of(&self, owner: &ContractAddress) -> u64 {
        self.balances
            .at(owner)
            .try_get()
            .none_if_missing()
            .unwrap_or(0)
    }

    /// The line the two interfaces meet on: a `Ledger` operation refused for
    /// a `Pausable` reason, reported with `Pausable`'s error type.
    fn _require_running(&self) {
        ensure(!self._paused(), PauseError::EnforcedPause);
    }

    fn _require_operator(&self) {
        let operator = self.operator.try_get().none_if_missing();
        ensure(operator == Some(get_caller()), PauseError::NotOperator);
    }
}

/// Setup, plus the guest-side catch this example exists for.
#[contract(client = LedgerAdminClient)]
impl PausableLedger {
    /// Record who may pause this ledger.
    pub fn initialize(&mut self, operator: &ContractAddress) {
        self.operator.set(operator);
        self.paused.set(&false);
    }

    /// Withdraw from *another* ledger through its [`LedgerClient`], and
    /// report what came back: 0 success, 1 fault, 2 insufficient funds,
    /// 3 zero amount, 4 paused, 5 anything else.
    ///
    /// Arms 2 and 3 name errors `Ledger` declares; arm 4 names one it does
    /// not — `PauseError` belongs to [`Pausable`]. The macro treats them
    /// alike, because each arm dispatches on the selector its pattern pins.
    pub fn withdraw_from(target: &ContractAddress, amount: u64) -> u32 {
        let ledger = LedgerClient::new(target);

        match ledger.try_withdraw(amount) {
            Ok(()) => 0,
            // Carries no exception to decode, so it stays an ordinary
            // `match` arm rather than reaching the wildcard below.
            Err(CallError::Fault(_)) => 1,
            Err(e) => match_exn!(e, {
                LedgerError::InsufficientFunds { .. } => 2,
                LedgerError::ZeroAmount => 3,
                // Declared by `Pausable`, thrown out of a `Ledger` method,
                // and caught here as a peer of the two arms above.
                PauseError::EnforcedPause => 4,
                _ => 5,
            }),
        }
    }
}

#[contract]
impl Ledger for PausableLedger {
    fn deposit(&mut self, amount: u64) {
        self._require_running();
        ensure(amount > 0, LedgerError::ZeroAmount);

        let owner = get_caller();
        let held = self._balance_of(&owner);
        self.balances.at_mut(&owner).set(&(held + amount));
    }

    fn withdraw(&mut self, amount: u64) {
        // Refused for a `Pausable` reason, with `Pausable`'s error type.
        self._require_running();
        ensure(amount > 0, LedgerError::ZeroAmount);

        let owner = get_caller();
        let held = self._balance_of(&owner);
        ensure(
            held >= amount,
            LedgerError::InsufficientFunds {
                held,
                requested: amount,
            },
        );

        self.balances.at_mut(&owner).set(&(held - amount));
    }

    fn balance(&self) -> u64 {
        self._balance_of(&get_caller())
    }
}

#[contract]
impl Pausable for PausableLedger {
    fn pause(&mut self) {
        self._require_operator();
        ensure(!self._paused(), PauseError::EnforcedPause);
        self.paused.set(&true);
    }

    fn unpause(&mut self) {
        self._require_operator();
        ensure(self._paused(), PauseError::ExpectedPause);
        self.paused.set(&false);
    }

    fn paused(&self) -> bool {
        self._paused()
    }
}
