//! Admission control for a contract's unbounded collection.
//!
//! Anything a contract lets the public add to -- a queue of pending requests,
//! a list of registered somethings -- grows storage the contract itself pays
//! for.  Under a cost model where storage is a deposit locked out of the
//! contract's own balance, an unbounded collection is an unbounded claim on
//! whoever funded it.
//!
//! [`Slots`] is a ceiling on that: a count of the room still left, taken as
//! entries arrive and given back as they leave.  It is deliberately *only*
//! the counter -- it does not hold the entries, and does not care what they
//! are -- so a contract keeps whatever collection suits it and puts a bound
//! on it with this.
//!
//! The interesting part is what happens at the ceiling, which is a property
//! of *how* the count is kept rather than of the count itself; see
//! [`Slots::reserve`].
//!
//! # Relation to the SDK
//!
//! This is a thin facade over [`sdk::storage::CapacityConstraint`], which is
//! the runtime's own mechanism for a constraint that has to hold *across* the
//! transactions in a block rather than within one.  Everything load-bearing
//! here -- the commit-time check, and what becomes of a transaction that
//! fails it -- is that type's, and through it the runtime's.
//!
//! What this adds is a vocabulary for the one case of counting entries in and
//! out: `u32` counts rather than the general `i128` weighted sum
//! (`Σ aᵢxᵢ ≤ b`) a `CapacityConstraint` can express, and a reader documented
//! for what a block-stale count is actually good for.  A contract wanting
//! weights, or a ceiling on something other than a count of things, wants the
//! SDK type directly.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::*;
use sdk::*;

/// A ceiling on how many entries a collection may hold: the room still left
/// in it.
///
/// Held as *remaining* capacity rather than as a length, so that concurrent
/// additions never have to read it.  Each takes its slot as a blind delta,
/// and the runtime enforces the floor across the whole block when those
/// deltas are reserved -- so any number of transactions may add in one block
/// without conflicting with each other, only with the ceiling, and only in
/// aggregate.  A length would have to be read to be incremented, and every
/// addition in a block would then conflict with every other.
///
/// A [`CapacityConstraint`] underneath, which is where that behaviour comes
/// from; the changes staged by the calls below are flushed to storage
/// together when this handle drops.
///
/// There is deliberately no way to read the count.  A read would see the last
/// committed value plus the reading transaction's own deltas -- never a
/// concurrent addition's -- so it would be stale in exactly the blocks where
/// a caller would want it, and identical for every addition in one block.
/// [`remaining_at_snapshot`](Self::remaining_at_snapshot) is the one narrow
/// exception, and documents what it is good for.
///
/// # Example
///
/// ```ignore
/// #[storage]
/// pub struct Registry {
///     entries: RCQ<Entry>,
///     slots: Node<Slots>,
/// }
///
/// fn initialize(&mut self, capacity: u32) {
///     self.slots.set_capacity(capacity);
/// }
///
/// fn add(&mut self, entry: Entry) {
///     self.slots.reserve();
///     self.entries.insert(&entry);
/// }
///
/// fn take(&mut self) -> Option<Entry> {
///     let entry = self.entries.try_consume().none_if_missing()?;
///     self.slots.release(1);
///     Some(entry)
/// }
/// ```
#[derive(Storage)]
pub struct Slots {
    remaining: CapacityConstraint,
}

impl Slots {
    /// Set the ceiling: the most entries the collection behind these slots
    /// will hold.  Call once, when the contract is initialized.
    ///
    /// Until this is called the ceiling is zero, so a contract that skipped
    /// initialization admits nothing -- rather than admitting any number of
    /// entries it cannot pay for.
    ///
    /// Aborts if this transaction has already taken or returned a slot, since
    /// setting the ceiling discards what the transaction recorded; repeating
    /// the same capacity is a no-op.  That check is *within a transaction*
    /// only.  Calling this again in a later transaction resets the ceiling and
    /// silently forgets every slot still outstanding -- so a contract that
    /// must be initialized once needs its own guard for that, as an
    /// already-initialized check on its own state.
    pub fn set_capacity(&mut self, capacity: u32) {
        self.remaining.set_capacity(i128::from(capacity));
    }

    /// Take the slot for one entry about to be added.
    ///
    /// Deliberately the *lazy* increment.  The floor is enforced when the
    /// transaction's deltas are reserved rather than checked against the
    /// snapshot here, and that difference is what becomes of an addition that
    /// arrives at a full collection: this way it is excluded from its block
    /// and returned to the mempool, landing once a removal frees capacity.  A
    /// call-time check (`strict_inc`) would instead revert the frame, leaving
    /// the transaction in the block with no effect and no retry -- turning
    /// "you were early" into "you failed".
    ///
    /// So a caller that arrives at a full collection waits rather than fails,
    /// and one that cannot wait indefinitely bounds that with its
    /// transaction's expiry height.
    pub fn reserve(&mut self) {
        self.remaining.consume_capacity(1);
    }

    /// Return the slots of `count` entries that have left.
    pub fn release(&mut self, count: u32) {
        self.remaining.consume_capacity(-i128::from(count));
    }

    /// The room left as of this block's snapshot -- so, with the ceiling, how
    /// full the collection was when the block began.
    ///
    /// Deliberately narrow.  This does not see the entries concurrent
    /// transactions are adding in this very block, and cannot: a reader sees
    /// the last committed value plus its own deltas and nothing else.  It is
    /// therefore no good for telling anyone how full the collection *is* --
    /// every addition in a block would read the same answer, and all of them
    /// stale.
    ///
    /// What it is good for is a decision that stays correct when the true
    /// occupancy is greater than the answer, since reading low is the only
    /// way this can be wrong.
    /// Clamped, so an over-reserved collection reads as full rather than as a
    /// negative number.  Reading low is the safe direction for the decisions
    /// this is for.
    pub fn remaining_at_snapshot(&self) -> u32 {
        self.remaining
            .get_remaining_capacity()
            .clamp(0, i128::from(u32::MAX)) as u32
    }
}
