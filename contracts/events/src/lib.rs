#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::*;

sdk::declare_mock_contract!();

// ── Event types ──────────────────────────────────────────────────────────

/// Simplest possible event: payload only, no user-defined topics.
/// Gets one auto-generated topic (the SIGNATURE hash).
#[derive(Event)]
pub struct ValueStored {
    pub key: u64,
    pub value: u64,
}

/// Event with address topics for indexed filtering.
/// Topics are ContractAddress (32 bytes), passed through as-is.
#[derive(Event)]
pub struct Transfer<'a> {
    #[topic]
    pub from: &'a ContractAddress,
    #[topic]
    pub to: &'a ContractAddress,
    pub amount: u64,
    pub memo: &'a [u8],
}

/// Event with a hashed string topic and a padded big-endian integer topic.
#[derive(Event)]
pub struct TaggedAction<'a> {
    #[topic]
    pub category: &'a str,
    #[topic]
    pub code: u32,
    pub detail: &'a [u8],
}

/// Event with no payload — topics only.
#[derive(Event)]
pub struct Checkpoint<'a> {
    #[topic]
    pub origin: &'a ContractAddress,
}

// ── Contract ─────────────────────────────────────────────────────────────

#[contract_exception]
pub enum EventsError {
    Unreachable = 1,
}

pub struct Events;

#[contract(
    throws = EventsError,
    emits(ValueStored, Transfer, TaggedAction, Checkpoint)
)]
impl Events {
    /// Emit a simple payload-only event.
    pub fn store_value(key: u64, value: u64) {
        log_event(&ValueStored { key, value });
    }

    /// Emit a transfer event with address topics.
    pub fn transfer(from: &ContractAddress, to: &ContractAddress, amount: u64) {
        log_event(&Transfer {
            from,
            to,
            amount,
            memo: b"",
        });
    }

    /// Emit a tagged action with string and integer topics.
    pub fn tag_action(category: &[u8], code: u32, detail: &[u8]) {
        let cat = core::str::from_utf8(category).unwrap_or("unknown");
        log_event(&TaggedAction {
            category: cat,
            code,
            detail,
        });
    }

    /// Emit a checkpoint event (topics only, no payload).
    pub fn checkpoint(origin: &ContractAddress) {
        log_event(&Checkpoint { origin });
    }

    /// Emit multiple events in a single call.
    pub fn multi_emit(addr: &ContractAddress) {
        log_event(&ValueStored { key: 1, value: 100 });
        log_event(&Transfer {
            from: addr,
            to: addr,
            amount: 50,
            memo: b"batch",
        });
        log_event(&Checkpoint { origin: addr });
    }
}
