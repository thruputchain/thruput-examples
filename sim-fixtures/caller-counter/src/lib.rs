#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::{Map, NNInt};
use sdk::*;

sdk::declare_mock_contract!();

/// Per-caller counter.
///
/// Each distinct `get_caller()` (`msg.sender`) owns an independent count, so
/// concurrent callers never share a slot. This makes it a clean read-after-write
/// fixture: `bump()` is the write and `get()` is the write-dependent read-back,
/// and a caller's value advances by exactly one per `bump()` regardless of other
/// callers.
#[sdk::storage]
pub struct CallerCounter {
    counts: Map<ContractAddress, NNInt>,
}

#[contract]
impl CallerCounter {
    /// Increment the caller's counter by one.
    pub fn bump(&mut self) {
        self.counts.at_mut(&get_caller()).strict_inc(1);
    }

    /// Return the caller's current counter value, or zero if never bumped.
    pub fn get(&self) -> u64 {
        self.counts.at(&get_caller()).try_get().unwrap_or(0) as u64
    }
}
