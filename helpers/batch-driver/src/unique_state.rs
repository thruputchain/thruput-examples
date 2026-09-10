//! Ids that are distinct across every request a driver accepts.

use sdk::storage::*;
use sdk::*;

/// A source of ids that are distinct across every request a driver accepts.
///
/// An id is the enqueuing transaction's hash and a counter, hashed together.
/// Each half covers what the other cannot:
///
/// * The transaction hash separates requests enqueued in *different*
///   transactions, including concurrent ones in the same block, and lets a
///   caller correlate an id with the submission it came from.
/// * The counter separates requests enqueued in *one* transaction, which share
///   that hash.
///
/// The counter is an `NNInt`, so [`next_id`](Self::next_id) increments it as a
/// blind delta and never conflicts with a concurrent enqueue -- the same
/// property that lets the [`RCQ`] behind it be written concurrently.  Two
/// transactions in one block therefore read the same counter value, and it is
/// the transaction hash that keeps their ids apart.
///
#[derive(Storage)]
pub struct UniqueState {
    seq: NNInt,
}

impl UniqueState {
    /// Mint an id no other request has been given.
    pub fn next_id(&mut self) -> SHA256Hash {
        self.seq.inc(1);
        (get_source_transaction_hash(), self.seq.get()).hash()
    }
}
