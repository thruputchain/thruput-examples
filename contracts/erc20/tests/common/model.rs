use alloc::collections::BTreeMap as Map;
use alloc::vec::Vec;
use erc20::ClawbackEvent;
use thruput_erc20_if::*;
use thruput_sdk::types::event::TxEmittedEvent;
use thruput_sdk::*;

/// A model of an ERC20 contract, for comparing state to ERC20 contracts under test
#[derive(Default, Clone)]
pub struct Model {
    pub contract_owner: Option<ContractAddress>,
    pub total_supply: Amount,
    pub balances: Map<ContractAddress, Amount>,
    pub allowances: Map<(ContractAddress, ContractAddress), Amount>,
    /// The ERC20 events the contract is expected to emit, in order. A forced
    /// burn's accompanying `ClawbackEvent` is not an ERC20 event and is not
    /// modelled; see [`check_events`].
    pub events: Vec<StdERC20Event>,
}

// Implement the same interface that ERC20 does, and keep track of
// the expected state
impl Model {
    pub fn initialize(&mut self, owner: &ContractAddress) {
        assert_eq!(
            self.contract_owner, None,
            "Model contract has already been initialized"
        );

        self.contract_owner = Some(*owner);
    }

    fn get_caller(&self) -> ContractAddress {
        // In testing, the caller is always the contract owner
        self.contract_owner
            .expect("Model contract has not yet been initialized")
    }

    pub fn mint(&mut self, receiver: &ContractAddress, amount: Amount) {
        assert!(amount >= 0);
        self.total_supply = self.total_supply.checked_add(amount).unwrap();

        self.adjust_balance(receiver, amount);

        self.events
            .push((&ERC20Event::Mint(MintEvent::new(receiver, amount))).into());
    }

    /// The administrator destroys `amount` of `owner`'s tokens: a burn, which
    /// the contract reports with a `BurnEvent` and a `ClawbackEvent`.
    pub fn clawback(&mut self, owner: &ContractAddress, amount: Amount) {
        assert!(amount >= 0);
        self.total_supply = self.total_supply.checked_sub(amount).unwrap();

        self.adjust_balance(owner, -amount);

        self.events
            .push((&ERC20Event::Burn(BurnEvent::new(owner, amount))).into());
    }

    pub fn adjust_allowance(&mut self, spender: &ContractAddress, difference: Difference) {
        let owner = self.get_caller();
        let entry = self.allowances.entry((owner, *spender)).or_insert(0);

        *entry = (*entry).checked_add(difference).unwrap();
        assert!(*entry >= 0);

        self.log_allowance_change_event(&owner, spender, difference);
    }

    pub fn delete_allowance(&mut self, spender: &ContractAddress) {
        let owner = self.get_caller();
        let removed = self.allowances.insert((owner, *spender), 0).unwrap_or(0);

        let event =
            ERC20Event::AllowanceDelete(AllowanceDeleteEvent::new(&owner, spender, removed));
        self.events.push((&event).into());
    }

    pub fn transfer(&mut self, receiver: &'static ContractAddress, amount: Amount) {
        assert!(amount >= 0);
        let owner = self.get_caller();

        self.adjust_balance(&owner, -amount);
        self.adjust_balance(receiver, amount);

        self.log_transfer_event(&owner, receiver, amount);
    }

    fn adjust_balance(&mut self, owner: &ContractAddress, diff: Difference) {
        let bal = self.balances.entry(*owner).or_insert(0);

        *bal = (*bal).checked_add(diff).unwrap();
        assert!(*bal >= 0);
    }

    fn log_transfer_event(&mut self, from: &ContractAddress, to: &ContractAddress, amount: Amount) {
        let event = ERC20Event::Transfer(TransferEvent::new(from, to, amount));

        self.events.push((&event).into());
    }

    fn log_allowance_change_event(
        &mut self,
        owner: &ContractAddress,
        spender: &ContractAddress,
        difference: i128,
    ) {
        let event =
            ERC20Event::AllowanceChange(AllowanceChangeEvent::new(owner, spender, difference));

        self.events.push((&event).into());
    }
}

// Check our state against that of a supplied ERC20 contract
impl Model {
    pub fn check_total_supply(&self, client: &ERC20Client) {
        assert_eq!(client.total_supply(), self.total_supply);
    }

    pub fn check_balances(&self, client: &ERC20Client) {
        for (addr, model_bal) in &self.balances {
            let client_bal = client.get_balance_of(addr);

            assert_eq!(&client_bal, model_bal);
        }
    }

    pub fn check_allowances(&self, client: &ERC20Client) {
        for ((owner, spender), model_allowance) in &self.allowances {
            let allowance = client.allowance(owner, spender);

            assert_eq!(&allowance, model_allowance);
        }
    }

    pub fn check(&self, client: &ERC20Client) {
        self.check_total_supply(client);
        self.check_balances(client);
        self.check_allowances(client);
    }
}

/// Compare an expected event log (from the model) against the events a
/// transaction actually emitted.
///
/// A `ClawbackEvent` is the context the contract logs beside a forced burn's
/// `BurnEvent`. It is not an ERC20 event, so the model does not record it;
/// here it is checked for its signature and skipped.
pub fn check_events(expected: &[StdERC20Event], events: &[TxEmittedEvent]) {
    let mut events = events.iter().filter(|event| {
        let event: EmittedEvent = (*event).into();
        event.topic(0) != Some(ClawbackEvent::SIGNATURE)
    });

    // For each event from our modelled event log ...
    for (i, model_event) in expected.iter().enumerate() {
        // Get the next event from the transaction event log
        let emitted_event: EmittedEvent =
            events.next().expect("Unexpected end of event log").into();

        let event: ERC20Event = emitted_event
            .try_into()
            .unwrap_or_else(|e| panic!("Couldn't parse emitted event as an ERC20 event: {}", e));

        let event: StdERC20Event = (&event).into();

        assert_eq!(&event, model_event, "Event {} doesn't match", i);
    }

    let remaining = events.count();
    if remaining > 0 {
        panic!(
            "Test contract produced {} more events than expected",
            remaining
        );
    }
}

impl Model {
    /// Check model state against events emitted by a transaction
    #[allow(dead_code)]
    pub fn check_events(&self, events: &[TxEmittedEvent]) {
        check_events(&self.events, events);
    }
}
