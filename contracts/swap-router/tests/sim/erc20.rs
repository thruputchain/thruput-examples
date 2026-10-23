//! A typed client for the `ERC20` interface (see [`super::client`]).

use thruput_erc20_if::{Amount, Difference};
use thruput_testkit::{Caller, Contract, ContractCall, Result};

use super::Address;
use super::client::Bound;

#[derive(Debug, Clone)]
pub struct ERC20Client(Bound);

impl ERC20Client {
    /// The interface identity (name, version) methods are selected by.
    pub const INTERFACE: (&str, &str) = ("ERC20", "0.1.65");

    /// Bind the ERC20 at `address`, acting as `caller` (an agent's `&ctx` or a
    /// `Caller`).
    pub fn new(caller: &(impl AsRef<Caller> + ?Sized), address: Address) -> Self {
        let (interface, version) = Self::INTERFACE;
        Self::with_contract(caller, Contract::new(address, interface, version))
    }

    /// Bind a contract speaking another version of the interface.
    pub fn with_contract(caller: &(impl AsRef<Caller> + ?Sized), contract: Contract) -> Self {
        Self(Bound::new(caller, contract))
    }

    pub fn address(&self) -> Address {
        self.0.address()
    }

    pub fn initialize(&self, administrator: &Address) -> ContractCall<()> {
        self.0.call("initialize", administrator)
    }

    pub fn transfer(&self, receiver: &Address, amount: Amount) -> ContractCall<()> {
        self.0.call("transfer", &(*receiver, amount))
    }

    pub fn transfer_from(
        &self,
        owner: &Address,
        receiver: &Address,
        amount: Amount,
    ) -> ContractCall<()> {
        self.0.call("transfer_from", &(*owner, *receiver, amount))
    }

    pub fn adjust_allowance(&self, spender: &Address, difference: Difference) -> ContractCall<()> {
        self.0.call("adjust_allowance", &(*spender, difference))
    }

    pub fn delete_allowance(&self, spender: &Address) -> ContractCall<()> {
        self.0.call("delete_allowance", spender)
    }

    pub fn delete_balance(&self) -> ContractCall<()> {
        self.0.call("delete_balance", &())
    }

    pub fn mint(&self, receiver: &Address, amount: Amount) -> ContractCall<()> {
        self.0.call("mint", &(*receiver, amount))
    }

    pub async fn allowance(&self, owner: &Address, spender: &Address) -> Result<Amount> {
        self.0.view("allowance", &(*owner, *spender)).await
    }

    pub async fn get_balance_of(&self, addr: &Address) -> Result<Amount> {
        self.0.view("get_balance_of", addr).await
    }

    pub async fn get_balance(&self) -> Result<Amount> {
        self.0.view("get_balance", &()).await
    }

    pub async fn total_supply(&self) -> Result<Amount> {
        self.0.view("total_supply", &()).await
    }
}
