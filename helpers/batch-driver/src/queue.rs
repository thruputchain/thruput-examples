//! The queue itself: the entries, the room left in it, the ids it stamps,
//! and the policy governing all three.

use crate::BatchRequest;
use crate::drain::{budget_for_batch, process};
use crate::events::{RequestAccepted, RequestFailed, RequestsProcessed};
use sdk::stats::gas_remaining;
use sdk::storage::*;
use sdk::*;
use unique_ids::UniqueIds;

/// How deep a driver's queue may get, and how much of that depth a single
/// crank must process.
#[derive(Clone, Copy, ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
pub struct CrankPolicy {
    /// The most entries the queue will hold.  This is what bounds the storage
    /// deposit the queue can lock out of the driver's balance.
    pub capacity: u32,

    /// The most a crank can be required to clear before it may drain at all.
    /// A crank must process whatever is waiting, capped at this.
    pub min_batch: u32,
}

/// A [`CrankPolicy`] asking for a floor its queue could never hold.
#[derive(Debug)]
pub struct InvalidPolicy;

/// A crank that did not bring the gas its queue's policy owes.
#[derive(Debug)]
pub struct Starved;

/// A driver's request queue: the entries, the room left in it, and the ids it
/// stamps on what it accepts.
///
/// # Writing a driver
///
/// The request type carries the id the queue stamps on it, and declares what
/// one costs:
///
/// ```ignore
/// #[contract_type]
/// pub struct Request {
///     pub id: SHA256Hash,
///     pub op: Op,
/// }
///
/// impl BatchRequest for Request {
///     const GAS_LIMIT: u64 = 300_000;
///
///     fn gas_limit(&self) -> u64 {
///         match self.op { /* what this one deserves */ }
///     }
///
///     fn id(&self) -> SHA256Hash {
///         self.id
///     }
/// }
/// ```
///
/// The driver contract holds a queue besides whatever else it needs, and its
/// three typical methods are below.
///
/// ```ignore
/// #[storage]
/// pub struct Driver {
///     cfg: Value<Cfg>,
///     queue: Node<Queue<Request>>,
/// }
///
/// #[contract]
/// impl MyDriver for Driver {
///     fn initialize(&mut self, handler: &Address, capacity: u32, min_batch: u32) {
///         self.queue
///             .initialize(CrankPolicy { capacity, min_batch })
///             .unwrap_or_else(|_: InvalidPolicy| throw(MyError::InvalidConfiguration));
///
///         self.cfg.set_exclusive(&Cfg { handler: *handler });
///     }
///
///     fn request(&mut self, op: Op) -> SHA256Hash {
///         self.queue.enqueue(|id| Request { id, op })
///     }
///
///     fn process_requests(&mut self) -> (u32, u32) {
///         let cfg = self.cfg.get();
///
///         self.queue
///             .crank(|request, gas_limit| {
///                 cfg.handler()
///                     .with_commit_locking()
///                     .with_gas_limit(gas_limit)
///                     .try_handle(request)
///             })
///             .unwrap_or_else(|_: Starved| throw(MyError::BatchTooSmall))
///     }
/// }
/// ```
///
/// Commit-locking the handler call is what makes a failed request roll back
/// alone instead of taking the batch with it; see [`crank`](Self::crank).
#[derive(Storage)]
pub struct Queue<R: BatchRequest> {
    // The entries, which concurrent transactions insert into.
    requests: RCQ<R>,

    // The remaining capacity of the `requests` queue, whose maximum length is
    // configured when calling `initialize`.
    //
    // A queued entry costs storage (and thus locked HOGs), so this is what
    // stops a queue from being an unbounded claim on whoever funded the
    // driver.
    slots: CapacityConstraint,

    // The source of the id stamped on each accepted entry.
    ids: Node<UniqueIds>,

    // Held as one value, so reading it for a crank costs one storage item
    // rather than one per field.
    policy: Value<CrankPolicy>,
}

impl<R: BatchRequest> Queue<R> {
    /// Set the queue's policy.  Call once, when the driver is initialized.
    ///
    /// Fails if the floor exceeds the ceiling.
    ///
    /// ```ignore
    /// fn initialize(&mut self, capacity: u32, min_batch: u32) {
    ///     if self.cfg.try_get().none_if_missing().is_some() {
    ///         throw(MyError::AlreadyInitialized);
    ///     }
    ///     self.queue
    ///         .initialize(CrankPolicy { capacity, min_batch })
    ///         .unwrap_or_else(|_: InvalidPolicy| throw(MyError::InvalidConfiguration));
    /// }
    /// ```
    pub fn initialize(&mut self, policy: CrankPolicy) -> Result<(), InvalidPolicy> {
        if policy.min_batch > policy.capacity {
            return Err(InvalidPolicy);
        }

        self.policy.set(&policy);
        self.slots.set_capacity(i128::from(policy.capacity));

        Ok(())
    }

    /// Accept one entry, returning the id stamped on it.
    ///
    /// `stamp` is handed that id and returns the entry to insert, so a request
    /// type keeps its own way of carrying one.
    ///
    /// ```ignore
    /// fn request(&mut self, op: Op) -> SHA256Hash {
    ///     self.queue.enqueue(|id| Request { id, op })
    /// }
    /// ```
    ///
    /// The id comes back to the caller *and* rides along on the entry, which
    /// is what lets an off-chain caller match the request it submitted against
    /// the event it eventually produces -- the [`RequestAccepted`] emitted
    /// here, and later either the driver's own success event or the
    /// [`RequestFailed`] that [`crank`](Self::crank) emits.  A request type
    /// that discards the id in `stamp` still enqueues, but nothing downstream
    /// can name it.
    ///
    /// A driver wanting to permission its queue does so *before* calling this:
    /// an entry names whatever account its handler will act for, and neither
    /// this nor the handler can check that claim.
    ///
    /// If the queue is full the slot claim overruns the ceiling and the whole
    /// transaction is excluded from its block and returned to the mempool --
    /// the entry waits for room rather than failing, so a caller that cannot
    /// wait indefinitely bounds it with the transaction's expiry height.
    pub fn enqueue(&mut self, stamp: impl FnOnce(SHA256Hash) -> R) -> SHA256Hash {
        // Take this entry's room.  Deliberately *not* checked here: the floor
        // is enforced when the transaction's deltas are reserved, and that
        // difference is what becomes of an enqueue arriving at a full queue.
        // This way it is excluded from its block and returned to the mempool,
        // landing once a drain frees capacity; a call-time check would instead
        // revert the frame, leaving the transaction in the block with no
        // effect and no retry -- turning "you were early" into "you failed".
        self.slots.consume_capacity(1);

        let id = self.ids.next_id();
        self.requests.insert(&stamp(id));

        log_event(&RequestAccepted { request_id: &id });

        id
    }

    /// Drain the queue, handing each entry to `handle`, and return
    /// `(n_processed, n_failed)`.
    ///
    /// Refuses with [`Starved`] a crank whose frame cannot fund what the queue
    /// owes: whatever was waiting at the block's snapshot, capped at the
    /// policy's `min_batch`.
    ///
    /// The refusal happens before the queue is touched, so a refused crank
    /// neither drains nor leaves anything half-done, and costs its sender and
    /// nobody else.
    pub fn crank<F>(&mut self, mut handle: F) -> Result<(u32, u32), Starved>
    where
        F: FnMut(R, u64) -> Result<(), CallError>,
    {
        let policy = self.policy.get();
        let capacity = i128::from(policy.capacity);
        // How deep the queue was at this block's snapshot. (The remaining
        // capacity can read negative mid-transaction.)
        let queued = (capacity - self.slots.get_remaining_capacity()).clamp(0, capacity) as u32;
        let owed = queued.min(policy.min_batch);
        if gas_remaining() < budget_for_batch::<R>(owed) {
            return Err(Starved);
        }

        let (n_processed, n_failed) = process(&mut self.requests, |request, gas_limit| {
            // Read the id before the request is handed over: handling
            // consumes it.
            let id = request.id();

            let result = handle(request, gas_limit);
            if let Err(e) = &result {
                // A failure rolls the handler's frame back, so the terminal
                // event for a failed request has to come from here, in the
                // driver's own (committed) frame.
                log_event(&RequestFailed::of(&id, e));
            }

            result
        });

        // A batch that took nothing touches nothing: no delta, so nothing to
        // conflict with.
        if n_processed > 0 {
            // Every entry the batch took is out of the queue, including the
            // ones whose handling failed.  (Negative consumption is a
            // release.)
            self.slots.consume_capacity(-i128::from(n_processed));

            log_event(&RequestsProcessed {
                processed: n_processed,
                failed: n_failed,
            });
        }

        Ok((n_processed, n_failed))
    }
}
