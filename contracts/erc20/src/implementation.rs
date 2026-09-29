//! An implementation of ERC20

use crate::interface::*;
#[cfg(feature = "permit")]
use sdk::signer::Signed;
use sdk::storage::deletable::Deletable;
use sdk::storage::{Balance, Map, Value};
use sdk::*;

type Allowance = Balance;

#[sdk::storage]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct TokenContract {
    config: Value<Config>,
    balances: Map<ContractAddress, Balance>,
    allowances: Map<ContractAddress, Map<ContractAddress, Allowance>>,
    total_supply: Balance,
}

#[cfg(feature = "metadata")]
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct Config {
    pub administrator: ContractAddress,
    pub name: Option<Name>,
    pub symbol: Option<Symbol>,
    pub decimals: Option<u32>,
}

#[cfg(not(feature = "metadata"))]
#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct Config {
    pub administrator: ContractAddress,
}

impl TokenContract {
    fn _init(&mut self, config: &Config) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(ERC20Error::AlreadyInitialized);
        }

        self.config.set(config)
    }

    fn _administrator(&self) -> ContractAddress {
        self.config.get().administrator
    }

    // These internal functions do _not_ check authorization.

    fn _balance_amount_of(&self, owner: &ContractAddress) -> Amount {
        self.balances.at(owner).get()
    }

    fn _lazy_increase_balance(&mut self, owner: &ContractAddress, amount: Amount) {
        self.balances
            .at_mut(owner)
            .try_lazy_increase(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn _decrease_balance(&mut self, owner: &ContractAddress, amount: Amount) {
        self.balances
            .at_mut(owner)
            .try_decrease(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn _allowance(&self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        self.allowances.at(owner).at(spender).get()
    }

    // Move an allowance by a signed difference, from zero if empty.
    // Allowances are not bounded by total supply, so increases are strict to
    // preserve the interface's immediate TooLarge error.
    fn _apply_difference(allowance: &mut Allowance, difference: Difference) {
        let result = if difference >= 0 {
            allowance.try_increase(difference as u128)
        } else {
            allowance.try_decrease(difference.unsigned_abs())
        };
        result.unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    // Adjust the allowance for `owner` and `spender` by `difference` and emit
    // the change. With `exclusive`, the pair's entry is locked so no other
    // transaction's write to it lands in the same block.
    fn _adjust_allowance(
        &mut self,
        owner: &ContractAddress,
        spender: &ContractAddress,
        difference: Difference,
        exclusive: bool,
    ) {
        let mut owner_allowances = self.allowances.at_mut(owner);
        let mut allowance = if exclusive {
            owner_allowances.at_mut_exclusive(spender)
        } else {
            owner_allowances.at_mut(spender)
        };
        Self::_apply_difference(&mut allowance, difference);

        AllowanceChangeEvent::new(owner, spender, difference).log();
    }

    // Spend `amount` of `spender`'s allowance from `owner`. Spending emits no
    // allowance event: the transfer it pays for is the record.
    fn _spend_allowance(
        &mut self,
        owner: &ContractAddress,
        spender: &ContractAddress,
        amount: Amount,
    ) {
        self.allowances
            .at_mut(owner)
            .at_mut(spender)
            .try_decrease(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    // Revoke `spender`'s allowance from `owner`, freeing its storage entry,
    // and emit the negative remainder (zero for a missing entry).
    fn _clear_allowance(&mut self, owner: &ContractAddress, spender: &ContractAddress) {
        let mut owner_allowances = self.allowances.at_mut(owner);
        let mut allowance = owner_allowances.at_mut(spender);
        let cleared = allowance.get();
        // Delete rather than zero, freeing the entry's storage, and lock it so
        // no other transaction's write to the pair lands in the same block.
        allowance.delete_exclusive();

        AllowanceChangeEvent::new(owner, spender, -amount_to_diff(cleared)).log();
    }

    fn _increase_total_supply(&mut self, amount: Amount) {
        self.total_supply
            .try_increase(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn _decrease_total_supply(&mut self, amount: Amount) {
        self.total_supply
            .try_decrease(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn _total_supply(&self) -> Amount {
        self.total_supply.get()
    }
}

// This implements the ERC20 interface.
//
// The `contract` macro provides an exported entrypoint for each method.
//
#[contract(version = "0.1.5")]
impl ERC20 for TokenContract {
    fn initialize(&mut self, administrator: &ContractAddress) {
        self._init(&Config {
            administrator: *administrator,

            #[cfg(feature = "metadata")]
            name: None,

            #[cfg(feature = "metadata")]
            symbol: None,

            #[cfg(feature = "metadata")]
            decimals: None,
        });
    }

    fn transfer(&mut self, receiver: &ContractAddress, amount: Amount) {
        let owner = get_caller();

        self._decrease_balance(&owner, amount);
        self._lazy_increase_balance(receiver, amount);

        TransferEvent::new(&owner, receiver, amount_to_diff(amount)).log();
    }

    fn transfer_from(
        &mut self,
        owner: &ContractAddress,
        receiver: &ContractAddress,
        amount: Amount,
    ) {
        let spender = get_caller();

        self._spend_allowance(owner, &spender, amount);
        self._decrease_balance(owner, amount);
        self._lazy_increase_balance(receiver, amount);

        TransferEvent::new(owner, receiver, amount_to_diff(amount)).log();
    }

    fn adjust_allowance(
        &mut self,
        spender: &ContractAddress,
        difference: Difference,
        exclusive: bool,
    ) {
        let owner = get_caller();

        self._adjust_allowance(&owner, spender, difference, exclusive);
    }

    fn clear_allowance(&mut self, spender: &ContractAddress) {
        let owner = get_caller();

        self._clear_allowance(&owner, spender);
    }

    fn clear_balance(&mut self) {
        let owner = get_caller();
        let mut balance = self.balances.at_mut(&owner);
        ensure(balance.get() == 0, ERC20Error::BalanceNotZero);
        balance.delete_exclusive();
    }

    fn allowance(&self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        self._allowance(owner, spender)
    }

    fn get_balance_of(&self, owner: &ContractAddress) -> Amount {
        self._balance_amount_of(owner)
    }

    fn get_balance(&self) -> Amount {
        let owner = get_caller();
        self._balance_amount_of(&owner)
    }

    fn mint(&mut self, receiver: &ContractAddress, amount: Amount) {
        let caller = get_caller();
        ensure(
            caller == self._administrator(),
            ERC20Error::MustBeContractOwner,
        );

        // Establish the checked supply bound first. Once it holds, the lazy
        // receiver increase cannot overflow an individual balance.
        self._increase_total_supply(amount);
        self._lazy_increase_balance(receiver, amount);

        TransferEvent::new(CONTRACT_ADDR_ZERO, receiver, amount_to_diff(amount)).log();
    }

    fn burn(&mut self, owner: &ContractAddress, amount: Amount) {
        let caller = get_caller();
        ensure(
            caller == self._administrator(),
            ERC20Error::MustBeContractOwner,
        );

        self._decrease_balance(owner, amount);
        self._decrease_total_supply(amount);

        TransferEvent::new(owner, CONTRACT_ADDR_ZERO, amount_to_diff(amount)).log();
    }

    fn total_supply(&self) -> Amount {
        self._total_supply()
    }
}

#[cfg(feature = "metadata")]
#[contract(version = "0.1.5")]
impl ERC20Metadata for TokenContract {
    fn initialize(
        &mut self,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
    ) {
        self._init(&Config {
            administrator: *administrator,
            name,
            symbol,
            decimals,
        });
    }

    fn name(&self) -> Option<Name> {
        self.config.get().name
    }

    fn symbol(&self) -> Option<Symbol> {
        self.config.get().symbol
    }

    fn decimals(&self) -> Option<u32> {
        self.config.get().decimals
    }
}

// Off-chain approvals. Every method takes a grant auth token and treats its
// *minter* as the owner: `consume` reports that address from the runtime, so
// it is the one fact about a grant the submitter cannot choose. The grant was
// minted by the owner's wallet in this same frame (see `permit-wallet`), after
// the wallet verified the owner's off-chain signature. Reaching this contract
// at all already proves the grant was minted for it: the runtime refuses to
// consume a token anywhere but at its named consumer.
#[cfg(feature = "permit")]
#[contract(version = "0.1.0")]
impl ERC20Permit for TokenContract {
    fn transfer_from_signed(
        &mut self,
        grant: Signed<PermitGrant>,
        receiver: &ContractAddress,
        amount: Amount,
    ) {
        let (grant, owner) = grant.consume();
        // The grant names who may spend it and how much; the caller must be
        // them, asking for no more. No allowance is written, so this is the
        // whole authorization check. The grant is spent whatever `amount` is:
        // an unused remainder is not carried anywhere.
        if get_caller() != grant.spender {
            throw(ERC20PermitError::NotSpender);
        }
        if amount > grant.amount {
            throw(ERC20PermitError::ExceedsGrant);
        }
        self._decrease_balance(&owner, amount);
        self._lazy_increase_balance(receiver, amount);

        TransferEvent::new(&owner, receiver, amount_to_diff(amount)).log();
    }

    fn increase_allowance_signed(&mut self, grant: Signed<PermitGrant>) {
        let (grant, owner) = grant.consume();
        self._adjust_allowance(&owner, &grant.spender, amount_to_diff(grant.amount), false);
    }

    fn clear_allowance_signed(&mut self, grant: Signed<ClearAllowanceGrant>) {
        let (grant, owner) = grant.consume();
        self._clear_allowance(&owner, &grant.spender);
    }
}
