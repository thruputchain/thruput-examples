//! The queue itself: the entries, the room left in it, the ids it stamps,
//! and the policy governing all three.

use crate::BatchRequest;
use crate::drain::{budget_for_batch, process};
use crate::events::{RequestAccepted, RequestFailed, RequestsProcessed};
use queue_slots::Slots;
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
/// A driver supplies only what this cannot know: how to hand one request to
/// its handler.
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
/// The contract holds one of these beside whatever else it needs, and its
/// three entrypoints are the three methods below.  Each maps a helper error
/// onto the contract's own, since a contract's callers see its exceptions and
/// not this crate's:
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

    // Room left in `requests`, counted down as entries arrive and back up as
    // they are drained.
    slots: Node<Slots>,

    // The source of the id stamped on each accepted entry.
    ids: Node<UniqueIds>,

    // Held as one value, so reading it for a crank costs one storage item
    // rather than one per field.
    policy: Value<CrankPolicy>,
}

impl<R: BatchRequest> Queue<R> {
    /// Set the queue's policy.  Call once, when the driver is initialized.
    ///
    /// Until this is called the queue admits nothing: the ceiling starts at
    /// zero, so a driver that skipped initialization refuses every request
    /// rather than silently accepting any number of them.
    ///
    /// Fails if the floor exceeds the ceiling -- a crank could then be asked
    /// for a batch the queue is never allowed to hold, which no crank could
    /// satisfy.  A driver reports that as its own error:
    ///
    /// ```ignore
    /// fn initialize(&mut self, capacity: u32, min_batch: u32) {
    ///     self.queue
    ///         .initialize(CrankPolicy { capacity, min_batch })
    ///         .unwrap_or_else(|_: InvalidPolicy| throw(MyError::InvalidConfiguration));
    /// }
    /// ```
    ///
    /// Both figures are the driver's to choose, and they trade off against
    /// each other: see [`CrankPolicy`].
    pub fn initialize(&mut self, policy: CrankPolicy) -> Result<(), InvalidPolicy> {
        if policy.min_batch > policy.capacity {
            return Err(InvalidPolicy);
        }

        self.policy.set(&policy);
        self.slots.set_capacity(policy.capacity);

        Ok(())
    }

    /// Accept one entry, returning the id stamped on it.
    ///
    /// `stamp` is handed that id and returns the entry to insert, so a request
    /// type keeps its own way of carrying one -- the queue never dictates a
    /// field name or position:
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
    /// wait indefinitely bounds it with the transaction's expiry height.  See
    /// [`Slots::reserve`].
    pub fn enqueue(&mut self, stamp: impl FnOnce(SHA256Hash) -> R) -> SHA256Hash {
        self.slots.reserve();

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

        // Saturating only as a matter of consequence: the room left cannot
        // exceed the ceiling while this type owns both sides of it, but an
        // underflow here would abort every crank and strand the queue for
        // good, where reading a backlog of zero merely lets a small crank
        // through.
        let queued = policy
            .capacity
            .saturating_sub(self.slots.remaining_at_snapshot());
        let owed = queued.min(policy.min_batch);
        if gas_remaining() < budget_for_batch::<R>(owed) {
            return Err(Starved);
        }

        let (n_processed, n_failed) = process(&mut self.requests, |request, gas_limit| {
            // Read the id before the request is handed over: handling
            // consumes it.  A failure rolls the handler's frame back, so
            // the terminal event for a failed request has to come from
            // here, in the driver's own (committed) frame.
            let id = request.id();

            let result = handle(request, gas_limit);
            if let Err(e) = &result {
                log_event(&RequestFailed::of(&id, e));
            }

            result
        });

        // A batch that took nothing touches nothing: no delta, so nothing to
        // conflict with.  Even returning zero room would write a (zero) delta,
        // and an event nobody could learn anything from.
        if n_processed > 0 {
            // Every entry the batch took is out of the queue -- including the
            // ones whose handling failed -- so its room comes back.
            self.slots.release(n_processed);

            log_event(&RequestsProcessed {
                processed: n_processed,
                failed: n_failed,
            });
        }

        Ok((n_processed, n_failed))
    }
}
