#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::*;

thruput_sdk::declare_mock_contract!();

/// Reports the timepoint of the block it runs in.
///
/// Tests that move a local node's block time call `now()` as a view to check
/// that a contract sees the new time.
#[thruput_sdk::storage]
pub struct BlockClock {}

#[contract]
impl BlockClock {
    /// The current block's timepoint, in Unix nanoseconds.
    pub fn now(&self) -> u64 {
        block::get_block_timepoint().into_inner()
    }
}
