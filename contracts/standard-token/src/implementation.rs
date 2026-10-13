use sdk::storage::deletable::Deletable;
use sdk::storage::{Balance, Map, NNInt, Value};
use sdk::*;
use standard_token_factory_if::StandardTokenInitializer;
use thruput_erc20_controls_if::{ClawbackEvent, ERC20Burn, ERC20Clawback};
use thruput_erc20_if::*;
use thruput_erc20_metadata_if::*;

/// An allowance is a non-negative amount like a balance: a missing entry
/// reads as zero, a zero change touches no storage, and the checked
/// operations refuse to cross zero or `i128::MAX`.
type Allowance = Balance;

#[sdk::storage]
#[cfg_attr(feature = "dev", derive(Debug))]
pub struct TokenContract {
    config: Value<Config>,
    balances: Map<ContractAddress, Balance>,
    allowances: Map<ContractAddress, Map<ContractAddress, Allowance>>,
    total_supply: Balance,
}

#[contract_type]
#[derive(Clone)]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct Config {
    pub administrator: ContractAddress,
    pub name: Option<Name>,
    pub symbol: Option<Symbol>,
    pub decimals: Option<u32>,
}

struct InitialMint<'a> {
    holder: &'a ContractAddress,
    supply: Amount,
}

impl TokenContract {
    fn initialize_once(&mut self, config: &Config, initial_mint: Option<InitialMint<'_>>) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(ERC20Error::AlreadyInitialized);
        }

        if let Some(mint) = &initial_mint {
            check_amount(mint.supply);
            ensure(
                config.administrator != *CONTRACT_ADDR_ZERO && *mint.holder != *CONTRACT_ADDR_ZERO,
                ERC20Error::TooLarge,
            );
        }

        self.config.set_exclusive(config);

        if let Some(mint) = initial_mint {
            // `set(0)` is intentional: factory-created holders always have a
            // physical NNInt row, even when no tokens are initially minted.
            NNInt::from(self.balances.keypath().child(mint.holder)).set(mint.supply);
            if mint.supply != 0 {
                self.total_supply
                    .try_increase(mint.supply)
                    .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
                MintEvent::new(mint.holder, mint.supply).log();
            }
        }
    }

    fn administrator(&self) -> ContractAddress {
        self.config.get().administrator
    }

    fn require_administrator(&self) {
        ensure(
            get_caller() == self.administrator(),
            ERC20Error::MustBeContractOwner,
        );
    }

    fn amount(value: &Balance) -> Amount {
        value.get()
    }

    fn lazy_increase(value: &mut Balance, amount: Amount) {
        value
            .try_lazy_increase(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn decrease(value: &mut Balance, amount: Amount) {
        value
            .try_decrease(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn increase_supply(&mut self, amount: Amount) {
        self.total_supply
            .try_increase(amount)
            .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    fn balance_of(&self, owner: &ContractAddress) -> Amount {
        Self::amount(&self.balances.at(owner))
    }

    // A missing entry -- never granted, or deleted -- reads as zero.
    fn allowance_of(&self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        Self::amount(&self.allowances.at(owner).at(spender))
    }

    // Move an allowance by a signed difference, from zero if empty. Increases
    // are checked so either bound throws immediately.
    fn apply_difference(allowance: &mut Allowance, difference: Difference) {
        let result = if difference >= 0 {
            allowance.try_increase(difference)
        } else {
            // `i128::MIN` has no negation; no allowance could cover it either.
            let decrement = difference
                .checked_neg()
                .unwrap_or_else(|| throw(ERC20Error::TooLarge));
            allowance.try_decrease(decrement)
        };
        result.unwrap_or_else(|_| throw(ERC20Error::TooLarge));
    }

    // Adjust `spender`'s allowance from `owner` by `difference`.
    fn adjust_allowance_by(
        &mut self,
        owner: &ContractAddress,
        spender: &ContractAddress,
        difference: Difference,
    ) {
        let mut owner_allowances = self.allowances.at_mut(owner);
        let mut allowance = owner_allowances.at_mut(spender);
        Self::apply_difference(&mut allowance, difference);
    }

    // Spend `amount` of `spender`'s allowance from `owner`. Spending emits no
    // allowance event: the transfer it pays for is the record.
    fn spend_allowance(
        &mut self,
        owner: &ContractAddress,
        spender: &ContractAddress,
        amount: Amount,
    ) {
        Self::decrease(&mut self.allowances.at_mut(owner).at_mut(spender), amount);
    }

    // Move `amount` from `owner` to `receiver` and emit [`TransferEvent`].
    fn transfer_between(
        &mut self,
        owner: &ContractAddress,
        receiver: &ContractAddress,
        amount: Amount,
    ) {
        Self::decrease(&mut self.balances.at_mut(owner), amount);
        Self::lazy_increase(&mut self.balances.at_mut(receiver), amount);
        TransferEvent::new(owner, receiver, amount).log();
    }

    // Destroy `amount` of `owner`'s tokens and emit [`BurnEvent`].
    fn destroy(&mut self, owner: &ContractAddress, amount: Amount) {
        Self::decrease(&mut self.balances.at_mut(owner), amount);
        Self::decrease(&mut self.total_supply, amount);
        BurnEvent::new(owner, amount).log();
    }
}

#[contract]
impl ERC20 for TokenContract {
    fn initialize(&mut self, administrator: &ContractAddress) {
        self.initialize_once(
            &Config {
                administrator: *administrator,
                name: None,
                symbol: None,
                decimals: None,
            },
            None,
        );
    }

    fn transfer(&mut self, receiver: &ContractAddress, amount: Amount) {
        check_amount(amount);
        let owner = get_caller();
        self.transfer_between(&owner, receiver, amount);
    }

    fn transfer_from(
        &mut self,
        owner: &ContractAddress,
        receiver: &ContractAddress,
        amount: Amount,
    ) {
        check_amount(amount);
        let spender = get_caller();
        self.spend_allowance(owner, &spender, amount);
        self.transfer_between(owner, receiver, amount);
    }

    fn adjust_allowance(&mut self, spender: &ContractAddress, difference: Difference) {
        let owner = get_caller();
        self.adjust_allowance_by(&owner, spender, difference);
        AllowanceChangeEvent::new(&owner, spender, difference).log();
    }

    fn delete_allowance(&mut self, spender: &ContractAddress) {
        let owner = get_caller();
        let removed = self.allowance_of(&owner, spender);
        // Delete rather than zero, freeing the entry's storage, and lock it so
        // no other transaction's write to the pair lands in the same block.
        self.allowances
            .at_mut(&owner)
            .at_mut(spender)
            .delete_exclusive();
        AllowanceDeleteEvent::new(&owner, spender, removed).log();
    }

    fn delete_balance(&mut self) {
        let owner = get_caller();
        let mut balance = self.balances.at_mut(&owner);
        ensure(balance.get() == 0, ERC20Error::BalanceNotZero);
        balance.delete_exclusive();
    }

    fn allowance(&self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        self.allowance_of(owner, spender)
    }

    fn get_balance_of(&self, owner: &ContractAddress) -> Amount {
        self.balance_of(owner)
    }

    fn get_balance(&self) -> Amount {
        self.balance_of(&get_caller())
    }

    fn mint(&mut self, receiver: &ContractAddress, amount: Amount) {
        check_amount(amount);
        self.require_administrator();
        self.increase_supply(amount);
        Self::lazy_increase(&mut self.balances.at_mut(receiver), amount);
        MintEvent::new(receiver, amount).log();
    }

    fn total_supply(&self) -> Amount {
        Self::amount(&self.total_supply)
    }
}

// Holders destroy their own tokens, or tokens they hold an allowance for.
#[contract]
impl ERC20Burn for TokenContract {
    fn burn(&mut self, amount: Amount) {
        check_amount(amount);
        let owner = get_caller();
        self.destroy(&owner, amount);
    }

    fn burn_from(&mut self, owner: &ContractAddress, amount: Amount) {
        check_amount(amount);
        let spender = get_caller();
        self.spend_allowance(owner, &spender, amount);
        self.destroy(owner, amount);
    }
}

// The administrator destroys tokens from any holder, no allowance needed. The
// burn is reported as such; the [`ClawbackEvent`] beside it records that it
// was forced.
#[contract]
impl ERC20Clawback for TokenContract {
    fn clawback(&mut self, from: &ContractAddress, amount: Amount) {
        check_amount(amount);
        self.require_administrator();
        self.destroy(from, amount);
        log_event(&ClawbackEvent { from, amount });
    }
}

#[contract]
impl ERC20Metadata for TokenContract {
    fn initialize(
        &mut self,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
    ) {
        self.initialize_once(
            &Config {
                administrator: *administrator,
                name,
                symbol,
                decimals,
            },
            None,
        );
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

#[contract]
impl StandardTokenInitializer for TokenContract {
    fn initialize_from_factory(
        &mut self,
        administrator: &ContractAddress,
        name: Option<Name>,
        symbol: Option<Symbol>,
        decimals: Option<u32>,
        initial_holder: &ContractAddress,
        initial_supply: Amount,
    ) {
        self.initialize_once(
            &Config {
                administrator: *administrator,
                name,
                symbol,
                decimals,
            },
            Some(InitialMint {
                holder: initial_holder,
                supply: initial_supply,
            }),
        );
    }
}

#[cfg(feature = "dev")]
pub fn balance_storage_key(owner: &ContractAddress) -> StorageKey {
    let state = sdk::storage::contract_state_root::<TokenContract>();
    state.balances.keypath().child(owner).generate_key()
}

#[cfg(feature = "dev")]
pub fn allowance_storage_key(owner: &ContractAddress, spender: &ContractAddress) -> StorageKey {
    let state = sdk::storage::contract_state_root::<TokenContract>();
    state
        .allowances
        .keypath()
        .child(owner)
        .child(spender)
        .generate_key()
}
