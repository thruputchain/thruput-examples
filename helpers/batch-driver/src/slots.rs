//! Admission control: a ceiling on how much a driver's queue can hold.

use sdk::storage::*;
use sdk::*;

/// Admission control for a driver's queue: the room still left in it.
///
/// (This is used internally by [`Queue`], but is available for other uses by
/// contracts that need more control.)
///
/// A queued entry costs storage, and that storage is a deposit locked out of
/// the driver contract's own HOG balance, so whoever funds a driver wants a
/// stated ceiling on how much it can be made to hold.  `Slots` is that ceiling,
/// held as *remaining* capacity so that concurrent enqueues never have to read
/// it: each takes its slot as a blind delta, and the runtime enforces the floor
/// across the whole block when their deltas are reserved.
///
/// There is deliberately no way to read the count.  A read would see the last
/// committed value plus the reading transaction's own deltas -- never a
/// concurrent enqueue's -- so it would be stale in exactly the blocks where a
/// caller would want it, and identical for every request in one block.
///
/// # Example
///
/// ```ignore
/// #[storage]
/// pub struct Driver {
///     requests: RCQ<Request>,
///     slots: Node<Slots>,
/// }
///
/// fn initialize(&mut self, max_queue_len: u32) {
///     self.slots.set_capacity(max_queue_len);
/// }
///
/// fn request(&mut self, request: Request) {
///     self.slots.reserve();
///     self.requests.insert(&request);
/// }
///
/// fn process_requests(&mut self) -> (u32, u32) {
///     let (n_processed, n_failed) = batch_driver::process(...);
///     self.slots.release(n_processed);
///     (n_processed, n_failed)
/// }
/// ```
///
/// [`Queue`]: crate::Queue
#[derive(Storage)]
pub struct Slots {
    remaining: NNInt,
}

impl Slots {
    /// Set the ceiling: the most entries the queue behind these slots will
    /// hold.  Call once, when the driver is initialized.
    pub fn set_capacity(&mut self, capacity: u32) {
        self.remaining.set(i128::from(capacity));
    }

    /// Take the slot for one entry about to be enqueued.
    ///
    /// Deliberately the *lazy* increment.  The floor is enforced when the
    /// transaction's deltas are reserved rather than checked against the
    /// snapshot here, and that difference is what becomes of an enqueue that
    /// arrives at a full queue: this way it is excluded from its block and
    /// returned to the mempool, landing once a drain frees capacity.  A
    /// call-time check (`strict_inc`) would instead revert the frame, leaving
    /// the transaction in the block with no effect and no retry -- turning
    /// "you were early" into "you failed".
    pub fn reserve(&mut self) {
        self.remaining.inc(-1);
    }

    /// Return the slots of `count` entries that have left the queue.
    pub fn release(&mut self, count: u32) {
        self.remaining.inc(i128::from(count));
    }

    /// The room left as of this block's snapshot -- so, with the ceiling, how
    /// deep the queue was when the block began.
    ///
    /// Deliberately narrow.  This does not see the entries concurrent
    /// transactions are adding in this very block, and cannot: a reader sees
    /// the last committed value plus its own deltas and nothing else.  It is
    /// therefore no good for telling anyone how full the queue *is* -- every
    /// enqueue in a block would read the same answer, and all of them stale.
    ///
    /// What it is good for is a decision that stays correct when the true
    /// depth is greater than the answer, since that is the only way this can
    /// be wrong.  Refusing an under-funded crank once the queue is deep is
    /// such a decision: reading low only lets one more small crank through.
    pub fn remaining_at_snapshot(&self) -> u32 {
        self.remaining
            .try_get()
            .none_if_missing()
            .unwrap_or(0)
            .clamp(0, i128::from(u32::MAX)) as u32
    }
}
