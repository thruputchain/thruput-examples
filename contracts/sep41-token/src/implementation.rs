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
    metadata: Value<TokenMetadata>,
    balances: Map<ContractAddress, Balance>,
}

/// The token's decimals, name and symbol.
#[contract_type]
pub struct TokenMetadata {
    pub decimal: u32,
    pub name: String,
    pub symbol: String,
}

/// The failure of the administrator's interface that SEP-41 has no
/// counterpart for.
#[contract_exception]
pub enum TokenAdminError {
    /// `initialize` was called on an initialized token.
    AlreadyInitialized = 1,
}

/// SEP-41's `address.require_auth()`. Groundhog authenticates the contract
/// making a call, so an account authorizes a call by making it: `address`
/// must be the caller.
fn require_auth(address: &ContractAddress) {
    ensure(get_caller() == *address, TokenError::Unauthorized);
}

fn check_nonnegative_amount(amount: i128) {
    ensure(amount >= 0, TokenError::NegativeAmount);
}

// Amounts reach these helpers checked non-negative, so `as u128` keeps their
// value, and a `Balance` never holds more than `i128::MAX`, so `as i128` keeps
// its.
impl Token {
    fn read_balance(&self, id: &ContractAddress) -> i128 {
        self.balances.at(id).get() as i128
    }

    fn receive_balance(&mut self, id: &ContractAddress, amount: i128) {
        self.balances
            .at_mut(id)
            .try_increase(amount as u128)
            .unwrap_or_else(|_| throw(TokenError::BalanceOverflow));
    }

    fn spend_balance(&mut self, id: &ContractAddress, amount: i128) {
        self.balances
            .at_mut(id)
            .try_decrease(amount as u128)
            .unwrap_or_else(|_| throw(TokenError::InsufficientBalance));
    }
}

/// The functions SEP-41 leaves to each token.
///
/// `initialize` stands in for the Soroban token example's constructor, and
/// `mint` is that example's.
#[contract(
    interface = "TokenAdmin",
    throws(TokenError, TokenAdminError),
    emits(Mint)
)]
impl Token {
    /// Sets the token's administrator and metadata.
    ///
    /// Throws [`TokenAdminError::AlreadyInitialized`] after the first call, so
    /// deploy and initialize the token in one transaction, leaving nobody a
    /// chance to call it first.
    pub fn initialize(
        &mut self,
        admin: &ContractAddress,
        decimal: u32,
        name: String,
        symbol: String,
    ) {
        if self.admin.try_get().none_if_missing().is_some() {
            throw(TokenAdminError::AlreadyInitialized);
        }

        // Exclusive, so that two initializations in one block cannot both
        // commit.
        self.admin.set_exclusive(admin);
        self.metadata.set(&TokenMetadata {
            decimal,
            name,
            symbol,
        });
    }

    /// Mints `amount` to `to`. Authorized by the administrator, who must be
    /// the caller.
    ///
    /// Emits [`Mint`].
    pub fn mint(&mut self, to: &ContractAddress, amount: i128) {
        require_auth(&self.admin.get());
        check_nonnegative_amount(amount);

        self.receive_balance(to, amount);
        log_event(&Mint { to, amount });
    }
}

#[contract]
impl TokenInterface for Token {
    fn balance(&self, id: &ContractAddress) -> i128 {
        self.read_balance(id)
    }

    fn transfer(&mut self, from: &ContractAddress, to: &ContractAddress, amount: i128) {
        require_auth(from);
        check_nonnegative_amount(amount);

        self.spend_balance(from, amount);
        self.receive_balance(to, amount);
        log_event(&Transfer { from, to, amount });
    }

    fn burn(&mut self, from: &ContractAddress, amount: i128) {
        require_auth(from);
        check_nonnegative_amount(amount);

        self.spend_balance(from, amount);
        log_event(&Burn { from, amount });
    }

    fn decimals(&self) -> u32 {
        self.metadata.get().decimal
    }

    fn name(&self) -> String {
        self.metadata.get().name
    }

    fn symbol(&self) -> String {
        self.metadata.get().symbol
    }
}
