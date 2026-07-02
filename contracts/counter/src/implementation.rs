use sdk::storage::NNInt;
use sdk::*;

#[contract_exception]
pub enum CounterError {
    NotAuthorized = 1,
}

#[derive(Event, Clone, Debug)]
pub struct PingEvent {
    #[topic]
    pub tag: u64,
}

/// A simple counter contract demonstrating commutative
/// NNInt operations. Multiple increment/decrement calls can
/// execute concurrently and merge correctly regardless of
/// order.
#[derive(Debug)]
#[sdk::storage]
pub struct Counter {
    value: NNInt,
}

#[contract(throws = CounterError, emits(PingEvent))]
impl Counter {
    pub fn initialize(&mut self, initial_value: u64) {
        self.value.strict_inc(initial_value as i128);
    }

    pub fn increment(&mut self, amount: u64) {
        self.value.strict_inc(amount as i128);
    }

    pub fn decrement(&mut self, amount: u64) {
        self.value.strict_inc(-(amount as i128));
    }

    pub fn get(&self) -> u64 {
        self.value.try_get().unwrap_or(0) as u64
    }

    pub fn ping(&self, tag: u64) {
        log_event(&PingEvent { tag });
    }

    pub fn error(&self) -> u64 {
        throw(CounterError::NotAuthorized);
    }
}
