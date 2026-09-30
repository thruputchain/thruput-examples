//! The SEP-41 token, and the functions SEP-41 leaves to it.
//!
//! Each `TokenInterface` function follows the Soroban token example's: check
//! the authorization, check the amount, move the balances, publish the event.

use sdk::storage::{Balance, Map, Value};
use sdk::*;
use sep41_token_if::*;

/// The token's state.
#[sdk::storage]
pub struct Token {
    admin: Value<ContractAddress>,
    balances: Map<ContractAddress, Balance>,
}

/// The ways the token's SEP-41 functions fail.
///
/// SEP-41 leaves the errors to each token, so `TokenInterface` declares none,
/// and the token defines its own.
#[contract_exception]
pub enum TokenError {
    /// An address whose authorization the call needs is not its caller.
    Unauthorized = 1,
    /// `amount` is negative.
    NegativeAmount = 2,
    /// The balance is less than `amount`.
    InsufficientBalance = 3,
    /// The receiving balance would exceed `i128::MAX`.
    BalanceOverflow = 4,
}

/// The failure of the administrator's interface that SEP-41 has no
/// counterpart for.
#[contract_exception]
pub enum TokenAdminError {
    /// `initialize` was called on an initialized token.
    AlreadyInitialized = 1,
}

/// Emitted when the administrator is changed, as the SAC's `set_admin` event
/// is.
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct SetAdmin<'a> {
    /// The administrator before the change.
    #[topic]
    pub admin: &'a ContractAddress,
    /// The administrator after it.
    pub new_admin: &'a ContractAddress,
}

/// SEP-41's `address.require_auth()`. Groundhog authenticates the contract
/// making a call, so an account authorizes a call by making it: `address`
/// must be the caller.
fn require_auth(address: &ContractAddress) {
    ensure(get_caller() == *address, TokenError::Unauthorized);
}

/// Returns `amount` as the `u128` a `Balance` takes, throwing
/// `NegativeAmount` if it is negative. The balance helpers take only that
/// `u128`, so every amount they move has been through this check.
fn require_nonnegative_amount(amount: i128) -> u128 {
    u128::try_from(amount).unwrap_or_else(|_| throw(TokenError::NegativeAmount))
}

impl Token {
    fn read_balance(&self, id: &ContractAddress) -> i128 {
        i128::try_from(self.balances.at(id).get()).expect("bug: a Balance holds at most i128::MAX")
    }

    fn receive_balance(&mut self, id: &ContractAddress, amount: u128) {
        self.balances
            .at_mut(id)
            .try_increase(amount)
            .unwrap_or_else(|_| throw(TokenError::BalanceOverflow));
    }

    fn spend_balance(&mut self, id: &ContractAddress, amount: u128) {
        self.balances
            .at_mut(id)
            .try_decrease(amount)
            .unwrap_or_else(|_| throw(TokenError::InsufficientBalance));
    }
}

/// The functions SEP-41 leaves to each token.
///
/// `initialize` stands in for the Soroban token example's constructor. `mint`
/// and `set_admin` are not part of SEP-41, but they match the Stellar Asset
/// Contract's functions of the same names, since diverging from them would
/// gain nothing.
#[contract(
    interface = "TokenAdmin",
    throws(TokenError, TokenAdminError),
    emits(Mint, SetAdmin)
)]
impl Token {
    /// Sets the token's administrator.
    ///
    /// Throws [`TokenAdminError::AlreadyInitialized`] after the first call, so
    /// deploy and initialize the token in one transaction, leaving nobody a
    /// chance to call it first.
    pub fn initialize(&mut self, admin: &ContractAddress) {
        if self.admin.try_get().none_if_missing().is_some() {
            throw(TokenAdminError::AlreadyInitialized);
        }

        // Exclusive, so that two initializations in one block cannot both
        // commit.
        self.admin.set_exclusive(admin);
    }

    /// Mints `amount` to `to`. Authorized by the administrator, who must be
    /// the caller.
    ///
    /// Emits [`Mint`].
    pub fn mint(&mut self, to: &ContractAddress, amount: i128) {
        // The amount first, then the authorization, as the SAC checks them.
        let value = require_nonnegative_amount(amount);
        require_auth(&self.admin.get());

        self.receive_balance(to, value);
        log_event(&Mint { to, amount });
    }

    /// Sets the administrator to `new_admin`. Authorized by the current
    /// administrator, who must be the caller.
    ///
    /// Emits [`SetAdmin`].
    pub fn set_admin(&mut self, new_admin: &ContractAddress) {
        let admin = self.admin.get();
        require_auth(&admin);

        // Exclusive, as in `initialize`, so that two changes of administrator
        // in one block cannot both commit.
        self.admin.set_exclusive(new_admin);
        log_event(&SetAdmin {
            admin: &admin,
            new_admin,
        });
    }
}

#[contract]
impl TokenInterface for Token {
    fn balance(&self, id: &ContractAddress) -> i128 {
        self.read_balance(id)
    }

    fn transfer(&mut self, from: &ContractAddress, to: &ContractAddress, amount: i128) {
        require_auth(from);
        let value = require_nonnegative_amount(amount);

        self.spend_balance(from, value);
        self.receive_balance(to, value);
        log_event(&Transfer { from, to, amount });
    }

    fn burn(&mut self, from: &ContractAddress, amount: i128) {
        require_auth(from);
        let value = require_nonnegative_amount(amount);

        self.spend_balance(from, value);
        log_event(&Burn { from, amount });
    }
}
