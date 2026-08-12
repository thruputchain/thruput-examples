use groundhog_erc20_if::*;
use groundhog_erc20_metadata_if::*;
use sdk::storage::{Balance, Map, NNInt, Value};
use sdk::*;
use standard_token_factory_if::StandardTokenInitializer;

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

        let initial_supply = initial_mint
            .as_ref()
            .map(|mint| amount_to_diff(mint.supply));
        if let Some(mint) = &initial_mint {
            ensure(
                config.administrator != *CONTRACT_ADDR_ZERO && *mint.holder != *CONTRACT_ADDR_ZERO,
                ERC20Error::TooLarge,
            );
        }

        self.config.set_exclusive(config);

        if let Some(mint) = initial_mint {
            let supply = initial_supply.unwrap_or(0);
            // `set(0)` is intentional: factory-created holders always have a
            // physical NNInt row, even when no tokens are initially minted.
            NNInt::from(self.balances.keypath().child(mint.holder)).set(supply);
            if supply != 0 {
                self.total_supply
                    .try_increase(mint.supply)
                    .unwrap_or_else(|_| throw(ERC20Error::TooLarge));
                log_transfer_event(CONTRACT_ADDR_ZERO, mint.holder, mint.supply);
            }
        }
    }

    fn administrator(&self) -> ContractAddress {
        self.config.get().administrator
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

    fn adjust_allowance_by(
        &mut self,
        owner: &ContractAddress,
        spender: &ContractAddress,
        diff: Difference,
    ) {
        let mut owner_allowances = self.allowances.at_mut(owner);
        let mut allowance = owner_allowances.at_mut(spender);
        let result = if diff >= 0 {
            allowance.try_increase(diff as u128)
        } else {
            allowance.try_decrease(diff.unsigned_abs())
        };
        result.unwrap_or_else(|_| throw(ERC20Error::TooLarge));
        log_approval_event(owner, spender, diff);
    }
}

#[contract(version = "0.1.6")]
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
        let owner = get_caller();
        Self::decrease(&mut self.balances.at_mut(&owner), amount);
        Self::lazy_increase(&mut self.balances.at_mut(receiver), amount);
        log_transfer_event(&owner, receiver, amount);
    }

    fn transfer_from(
        &mut self,
        owner: &ContractAddress,
        receiver: &ContractAddress,
        amount: Amount,
    ) {
        let spender = get_caller();
        self.adjust_allowance_by(owner, &spender, -amount_to_diff(amount));
        Self::decrease(&mut self.balances.at_mut(owner), amount);
        Self::lazy_increase(&mut self.balances.at_mut(receiver), amount);
        log_transfer_event(owner, receiver, amount);
    }

    fn adjust_allowance(&mut self, spender: &ContractAddress, diff: Difference) {
        self.adjust_allowance_by(&get_caller(), spender, diff);
    }

    fn allowance(&self, owner: &ContractAddress, spender: &ContractAddress) -> Amount {
        Self::amount(&self.allowances.at(owner).at(spender))
    }

    fn get_balance_of(&self, owner: &ContractAddress) -> Amount {
        self.balance_of(owner)
    }

    fn get_balance(&self) -> Amount {
        self.balance_of(&get_caller())
    }

    fn mint(&mut self, receiver: &ContractAddress, amount: Amount) {
        ensure(
            get_caller() == self.administrator(),
            ERC20Error::MustBeContractOwner,
        );
        self.increase_supply(amount);
        Self::lazy_increase(&mut self.balances.at_mut(receiver), amount);
        log_transfer_event(CONTRACT_ADDR_ZERO, receiver, amount);
    }

    fn burn(&mut self, owner: &ContractAddress, amount: Amount) {
        ensure(
            get_caller() == self.administrator(),
            ERC20Error::MustBeContractOwner,
        );
        Self::decrease(&mut self.balances.at_mut(owner), amount);
        Self::decrease(&mut self.total_supply, amount);
        log_transfer_event(owner, CONTRACT_ADDR_ZERO, amount);
    }

    fn total_supply(&self) -> Amount {
        Self::amount(&self.total_supply)
    }
}

#[contract(version = "0.1.6")]
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
