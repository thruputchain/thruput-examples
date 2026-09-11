//! Ids that are distinct across everything a contract accepts.
//!
//! A contract that takes work from the public generally has to name each piece of it, so that
//! whoever submitted one can recognise what became of it -- in an event, in a later query, as a
//! key. The name has to be distinct across every submission the contract ever accepts, including
//! several arriving in one transaction and several arriving in one block from transactions that
//! cannot see each other.
//!
//! [`UniqueIds`] is that source of names, and is careful about the second half: it never has to
//! read a value another transaction in the same block might also be writing, so minting an id never
//! conflicts with a concurrent mint. A contract that instead read a counter, added one, and wrote
//! it back would serialize its own submissions one per block.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::*;
use sdk::*;

/// A source of ids distinct across everything a contract accepts.
///
/// An id is the submitting transaction's hash and a counter, hashed together. Each half covers what
/// the other cannot:
///
/// * The transaction hash separates submissions made in *different* transactions, including
///   concurrent ones in the same block, and lets a caller correlate an id with the submission it
///   came from.
/// * The counter separates submissions made in *one* transaction, which share that hash.
///
/// The counter is an `NNInt`, so [`next_id`](Self::next_id) increments it as a blind delta: it is
/// never read against a snapshot, and so never conflicts with a concurrent mint. Two transactions
/// in one block therefore observe the same counter value, and it is the transaction hash that keeps
/// their ids apart -- which is why both halves are needed, and why neither alone would do.
///
/// Distinct *within one contract*, which is the scope that matters for naming a contract's own
/// work. Two contracts each minting their first id in the same transaction produce the same value,
/// since both hash that one transaction hash with a counter of zero. A contract that needs an id
/// distinct from another contract's should mix in its own address.
///
/// The ids are unpredictable to anyone who does not know the transaction hash, but they are not
/// secrets and not a source of randomness: the counter is sequential, and a submitter knows its own
/// transaction.
///
/// # Example
///
/// ```ignore
/// #[storage]
/// pub struct Registry {
///     ids: Node<UniqueIds>,
///     entries: Map<SHA256Hash, Entry>,
/// }
///
/// fn submit(&mut self, entry: Entry) -> SHA256Hash {
///     let id = self.ids.next_id();
///     self.entries.at_mut(&id).set(&entry);
///     id
/// }
/// ```
#[derive(Storage)]
pub struct UniqueIds {
    seq: NNInt,
}

impl UniqueIds {
    /// Mint an id nothing else has been given.
    pub fn next_id(&mut self) -> SHA256Hash {
        self.seq.inc(1);
        (get_source_transaction_hash(), self.seq.get()).hash()
    }
}
