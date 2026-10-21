use thruput_sdk::storage::Balance;
use thruput_sdk::*;

#[contract_exception]
pub enum CounterError {
    NotAuthorized = 1,
}

#[derive(Event, Clone, Debug)]
pub struct PingEvent {
    #[topic]
    pub tag: u64,
}

/// A nonnegative counter using Balance. Compatible increases and
/// decreases can merge across concurrent transactions within bounds.
#[derive(Debug)]
#[thruput_sdk::storage]
pub struct Counter {
    value: Balance,
}

#[contract(throws = CounterError, emits(PingEvent))]
impl Counter {
    pub fn initialize(&mut self, initial_value: u64) {
        self.value.increase(initial_value as i128);
    }

    pub fn increment(&mut self, amount: u64) {
        self.value.increase(amount as i128);
    }

    pub fn decrement(&mut self, amount: u64) {
        self.value.decrease(amount as i128);
    }

    pub fn get(&self) -> u64 {
        self.value.get() as u64
    }

    pub fn ping(&self, tag: u64) {
        log_event(&PingEvent { tag });
    }

    pub fn error(&self) -> u64 {
        throw(CounterError::NotAuthorized);
    }
}
