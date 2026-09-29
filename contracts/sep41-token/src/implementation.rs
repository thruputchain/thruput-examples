//! The SEP-41 token, and the functions SEP-41 leaves to it.
//!
//! Each `TokenInterface` function follows the Soroban token example's: check
//! the authorization, check the amount, move the allowance and balances,
//! publish the event.

use sdk::storage::{Balance, Map, NNInt, Node, Value};
use sdk::*;
use sep41_token_if::*;

/// The token's state.
#[sdk::storage]
pub struct Token {
    admin: Value<Address>,
    metadata: Value<TokenMetadata>,
    balances: Map<Address, Balance>,
    allowances: Map<Address, Map<Address, Node<Allowance>>>,
}

/// The token's decimals, name and symbol.
#[contract_type]
pub struct TokenMetadata {
    pub decimal: u32,
    pub name: String,
    pub symbol: String,
}

/// An allowance that `from` gave `spender`.
#[sdk::storage]
struct Allowance {
    /// `approve` replaces the amount, which a `Balance` cannot do, so it is an
    /// `NNInt`. Spending it is a decrement, which merges with other spends in
    /// the same block.
    amount: NNInt,
    live_until_ledger: Value<u32>,
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
fn require_auth(address: &Address) {
    ensure(get_caller() == *address, TokenError::Unauthorized);
}

fn check_nonnegative_amount(amount: i128) {
    ensure(amount >= 0, TokenError::NegativeAmount);
}

/// Whether `ledger` is before the current ledger, whose number is the block
/// height.
fn is_before_current_ledger(ledger: u32) -> bool {
    i64::from(ledger) < *get_block_height()
}

// Amounts reach these helpers checked non-negative, so `as u128` keeps their
// value, and a `Balance` never holds more than `i128::MAX`, so `as i128` keeps
// its.
impl Token {
    fn read_balance(&self, id: &Address) -> i128 {
        self.balances.at(id).get() as i128
    }

    fn receive_balance(&mut self, id: &Address, amount: i128) {
        self.balances
            .at_mut(id)
            .try_increase(amount as u128)
            .unwrap_or_else(|_| throw(TokenError::BalanceOverflow));
    }

    fn spend_balance(&mut self, id: &Address, amount: i128) {
        self.balances
            .at_mut(id)
            .try_decrease(amount as u128)
            .unwrap_or_else(|_| throw(TokenError::InsufficientBalance));
    }

    /// The allowance `from` gave `spender`, which is 0 once it has expired.
    fn read_allowance(&self, from: &Address, spender: &Address) -> i128 {
        let allowances = self.allowances.at(from);
        let allowance = allowances.at(spender);
        let Some(amount) = allowance.amount.try_get().none_if_missing() else {
            return 0;
        };
        if is_before_current_ledger(allowance.live_until_ledger.get()) {
            0
        } else {
            amount
        }
    }

    fn write_allowance(
        &mut self,
        from: &Address,
        spender: &Address,
        amount: i128,
        live_until_ledger: u32,
    ) {
        if amount > 0 && is_before_current_ledger(live_until_ledger) {
            throw(TokenError::LiveUntilLedgerInPast);
        }

        let mut allowances = self.allowances.at_mut(from);
        let mut allowance = allowances.at_mut(spender);
        allowance.amount.set(amount);
        allowance.live_until_ledger.set(&live_until_ledger);
    }

    /// Reduces the allowance `from` gave `spender` by `amount`, without
    /// changing when it expires.
    fn spend_allowance(&mut self, from: &Address, spender: &Address, amount: i128) {
        ensure(
            self.read_allowance(from, spender) >= amount,
            TokenError::InsufficientAllowance,
        );
        if amount > 0 {
            let mut allowances = self.allowances.at_mut(from);
            allowances.at_mut(spender).amount.strict_inc(-amount);
        }
    }
}

/// The functions SEP-41 leaves to each token.
///
/// `initialize` stands in for the Soroban token example's constructor, and
/// `mint` is that example's. `clawback` is the Stellar Asset Contract's.
#[contract(
    interface = "TokenAdmin",
    throws(TokenError, TokenAdminError),
    emits(Mint, Clawback)
)]
impl Token {
    /// Sets the token's administrator and metadata.
    ///
    /// Throws [`TokenAdminError::AlreadyInitialized`] after the first call, so
    /// deploy and initialize the token in one transaction, leaving nobody a
    /// chance to call it first.
    pub fn initialize(&mut self, admin: &Address, decimal: u32, name: String, symbol: String) {
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
    pub fn mint(&mut self, to: &Address, amount: i128) {
        require_auth(&self.admin.get());
        check_nonnegative_amount(amount);

        self.receive_balance(to, amount);
        log_event(&Mint {
            to,
            amount,
            to_muxed_id: None,
        });
    }

    /// Claws back `amount` from `from`, burning it. Authorized by the
    /// administrator, who must be the caller.
    ///
    /// Emits [`Clawback`], and no [`Burn`] or [`Transfer`].
    pub fn clawback(&mut self, from: &Address, amount: i128) {
        require_auth(&self.admin.get());
        check_nonnegative_amount(amount);

        self.spend_balance(from, amount);
        log_event(&Clawback { from, amount });
    }
}

#[contract]
impl TokenInterface for Token {
    fn allowance(&self, from: &Address, spender: &Address) -> i128 {
        self.read_allowance(from, spender)
    }

    fn approve(&mut self, from: &Address, spender: &Address, amount: i128, live_until_ledger: u32) {
        require_auth(from);
        check_nonnegative_amount(amount);

        self.write_allowance(from, spender, amount, live_until_ledger);
        log_event(&Approve {
            from,
            spender,
            amount,
            live_until_ledger,
        });
    }

    fn balance(&self, id: &Address) -> i128 {
        self.read_balance(id)
    }

    fn transfer(&mut self, from: &Address, to: MuxedAddress, amount: i128) {
        require_auth(from);
        check_nonnegative_amount(amount);

        self.spend_balance(from, amount);
        self.receive_balance(&to.address, amount);
        log_event(&Transfer {
            from,
            to: &to.address,
            amount,
            to_muxed_id: to.id,
        });
    }

    fn transfer_from(&mut self, spender: &Address, from: &Address, to: &Address, amount: i128) {
        require_auth(spender);
        check_nonnegative_amount(amount);

        self.spend_allowance(from, spender, amount);
        self.spend_balance(from, amount);
        self.receive_balance(to, amount);
        log_event(&Transfer {
            from,
            to,
            amount,
            to_muxed_id: None,
        });
    }

    fn burn(&mut self, from: &Address, amount: i128) {
        require_auth(from);
        check_nonnegative_amount(amount);

        self.spend_balance(from, amount);
        log_event(&Burn { from, amount });
    }

    fn burn_from(&mut self, spender: &Address, from: &Address, amount: i128) {
        require_auth(spender);
        check_nonnegative_amount(amount);

        self.spend_allowance(from, spender, amount);
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
