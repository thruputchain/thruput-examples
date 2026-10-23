//! The queue itself.

use crate::BatchRequest;
use crate::drain::{CLAIM_GAS, budget_for_batch, process};
use crate::events::{RequestAccepted, RequestFailed, RequestsProcessed};
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::storage::*;
use thruput_sdk::*;
use unique_ids::UniqueIds;

/// How deep a driver's queue may get, and how much of that depth a single crank must process.
#[derive(Clone, Copy, ReadXDR, WriteXDR)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
pub struct CrankPolicy {
    /// The most entries the queue will hold. This is what bounds the storage deposit the queue can
    /// lock out of the driver's balance.
    pub capacity: u32,

    /// The most a crank can be required to clear before it may drain at all. A crank must process
    /// whatever is waiting, capped at this.
    pub min_batch: u32,
}

/// A [`CrankPolicy`] asking for a floor its queue could never hold.
#[derive(Debug)]
pub struct InvalidPolicy;

/// A crank that did not bring the gas its queue's policy owes.
#[derive(Debug)]
pub struct Starved;

/// A driver's request queue: the entries, the room left in it, and the ids it stamps on what it
/// accepts.
///
/// # Writing a driver
///
/// The request type carries the id the queue stamps on it, and declares what one costs:
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
/// The driver contract holds a queue besides whatever else it needs, and its three typical methods
/// are below.
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
///             .crank(
///                 || cfg.handler().with_commit_locking().try_claim_crank(),
///                 |request, gas_limit| {
///                     cfg.handler()
///                         .with_commit_locking()
///                         .with_gas_limit(gas_limit)
///                         .try_handle(request)
///                 },
///             )
///             .unwrap_or_else(|_: Starved| throw(MyError::BatchTooSmall))
///     }
/// }
/// ```
///
/// Commit-locking the handler call is what makes a failed request roll back alone instead of taking
/// the batch with it; see [`crank`](Self::crank).
#[derive(Storage)]
pub struct Queue<R: BatchRequest> {
    // The entries, which concurrent transactions insert into.
    requests: RCQ<R>,

    // The remaining capacity of the `requests` queue, whose maximum length is configured when
    // calling `initialize`.
    //
    // A queued entry costs storage (and thus locked native tokens), so this is what stops a queue
    // from being an unbounded claim on whoever funded the driver.
    slots: CapacityConstraint,

    // The source of the id stamped on each accepted entry.
    ids: Node<UniqueIds>,

    policy: Value<CrankPolicy>,
}

impl<R: BatchRequest> Queue<R> {
    /// Set the queue's policy. Call once, when the driver is initialized.
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
    /// `stamp` is handed that id and returns the entry to insert, so a request type keeps its own
    /// way of carrying one.
    ///
    /// ```ignore
    /// fn request(&mut self, op: Op) -> SHA256Hash {
    ///     self.queue.enqueue(|id| Request { id, op })
    /// }
    /// ```
    ///
    /// The id comes back to the caller *and* rides along on the entry, which is what lets an
    /// off-chain caller match the request it submitted against the event it eventually produces:
    /// the [`RequestAccepted`] emitted here, and later either the driver's own success event or the
    /// [`RequestFailed`] that [`crank`](Self::crank) emits.
    ///
    /// A driver wanting to permission its queue does so *before* calling this: an entry names
    /// whatever account its handler will act for, and neither this nor the handler can check that
    /// claim.
    ///
    /// If the queue is full the slot claim overruns the ceiling, and the whole transaction fails at
    /// commit: it is left out of its block with nothing written. The caller may submit the same
    /// signed transaction again once a drain has made room (bounded by the transaction's expiry
    /// height).
    pub fn enqueue(&mut self, stamp: impl FnOnce(SHA256Hash) -> R) -> SHA256Hash {
        // Take this entry's room. Deliberately *not* checked here: the floor is enforced when the
        // transaction's deltas are reserved, and that difference is what becomes of an enqueue
        // arriving at a full queue. This way it fails at commit, left out of its block with nothing
        // written, and the same signed transaction can be submitted again once a drain frees
        // capacity.
        self.slots.consume_capacity(1);

        let id = self.ids.next_id();
        self.requests.insert(&stamp(id));

        log_event(&RequestAccepted { request_id: &id });

        id
    }

    /// Drain the queue, handing each entry to `handle`, and return `(n_processed, n_failed)`.
    ///
    /// Refuses with [`Starved`] a crank whose frame cannot fund its claim and what the queue owes:
    /// whatever was waiting at the block's snapshot, capped at the policy's `min_batch` (see
    /// [`CLAIM_GAS`](crate::CLAIM_GAS)).
    ///
    /// The refusal happens before the queue is touched, so a refused crank neither drains nor
    /// leaves anything half-done, and costs its sender and nobody else.
    ///
    /// If there is anything to drain, the crank first calls `claim`, which must make a
    /// commit-locked call that writes a claim key of the handler's exclusively (for instance with
    /// `Value::set_exclusive`). If it fails, another crank in this block holds the claim, and this
    /// one returns `(0, 0)` without draining. A crank that finds nothing to drain does not claim,
    /// so it stays as free as it was: it writes nothing, and takes the claim from no one.
    pub fn crank<C, F>(&mut self, claim: C, mut handle: F) -> Result<(u32, u32), Starved>
    where
        C: FnOnce() -> Result<(), CallError>,
        F: FnMut(R, u64) -> Result<(), CallError>,
    {
        #[cfg(feature = "calibration")]
        let entry_gas = gas_remaining();

        let policy = self.policy.get();
        let capacity = i128::from(policy.capacity);
        // How deep the queue was at this block's snapshot. (The remaining capacity can read
        // negative mid-transaction.)
        let queued = (capacity - self.slots.get_remaining_capacity()).clamp(0, capacity) as u32;
        let owed = queued.min(policy.min_batch);

        // Nothing to drain, so nothing to claim.
        if self.requests.try_peek().none_if_missing().is_none() {
            return Ok((0, 0));
        }

        // Claim only if, the claim having been paid for, this crank can still fund what the queue
        // owes, and at least one request: a crank that claimed and then drained nothing would hold
        // the block's drain from everyone. (Nothing is owed when what is waiting arrived in this
        // block; a crank that cannot fund one request then stays the free no-op it would be on an
        // empty queue.)
        if gas_remaining() < CLAIM_GAS.saturating_add(budget_for_batch::<R>(owed.max(1))) {
            return if owed > 0 { Err(Starved) } else { Ok((0, 0)) };
        }

        #[cfg(feature = "calibration")]
        let before_claim = gas_remaining();

        if claim().is_err() {
            return Ok((0, 0));
        }

        #[cfg(feature = "calibration")]
        let claim_gas = before_claim.saturating_sub(gas_remaining());

        #[cfg(feature = "calibration")]
        let mut spent = HandlerGas::default();

        let (n_processed, n_failed) = process(&mut self.requests, |request, gas_limit| {
            // Read the id before the request is handed over: handling consumes it.
            let id = request.id();

            #[cfg(feature = "calibration")]
            let before = gas_remaining();

            let result = handle(request, gas_limit);

            #[cfg(feature = "calibration")]
            spent.record(before.saturating_sub(gas_remaining()));

            if let Err(e) = &result {
                // A failure rolls the handler's frame back, so the terminal event for a failed
                // request has to come from here, in the driver's own (committed) frame.
                log_event(&RequestFailed::of(&id, e));
            }

            result
        });

        #[cfg(feature = "calibration")]
        let after_process = gas_remaining();

        if n_processed > 0 {
            // Every entry the batch took is out of the queue, including the ones whose handling
            // failed. (Negative consumption is a release.)
            self.slots.consume_capacity(-i128::from(n_processed));

            log_event(&RequestsProcessed {
                processed: n_processed,
                failed: n_failed,
            });
        }

        #[cfg(feature = "calibration")]
        {
            let here = gas_remaining();
            log_event(&GasReport {
                processed: n_processed,
                claim: claim_gas,
                dearest_request: spent.dearest,
                tail: after_process.saturating_sub(here),
                beyond_handlers: entry_gas
                    .saturating_sub(here)
                    .saturating_sub(spent.total)
                    .saturating_sub(claim_gas),
            });
        }

        Ok((n_processed, n_failed))
    }
}

/// Running totals of what the handler calls cost.
#[cfg(feature = "calibration")]
#[derive(Default)]
struct HandlerGas {
    dearest: u64,
    total: u64,
}

#[cfg(feature = "calibration")]
impl HandlerGas {
    fn record(&mut self, spent: u64) {
        self.total = self.total.saturating_add(spent);
        if spent > self.dearest {
            self.dearest = spent;
        }
    }
}

/// What one crank spent, measured on the node that ran it.
///
/// Emitted only under the `calibration` feature.  The three gas constants each
/// have a field here to be set from:
///
/// * [`CLAIM_GAS`] must cover `claim`, what claiming the drain cost.
/// * [`BatchRequest::GAS_LIMIT`] must bound `dearest_request`, since it is the
///   cap the drain puts on a single handler call.
/// * [`EPILOGUE_GAS`] must cover `beyond_handlers`, which is everything the
///   crank spent that was neither a handler call nor the claim: entering, checking the budget,
///   consuming and decoding each entry, releasing capacity, and the summary
///   event.  That over-counts the reserve's real job by the entries before the
///   last one, which is the safe direction. `tail` is the part after the final
///   handler call alone, for a tighter reading.
///
/// [`BatchRequest::GAS_LIMIT`]: crate::BatchRequest::GAS_LIMIT
/// [`EPILOGUE_GAS`]: crate::EPILOGUE_GAS
/// [`CLAIM_GAS`]: crate::CLAIM_GAS
#[cfg(feature = "calibration")]
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct GasReport {
    pub processed: u32,
    pub claim: u64,
    pub dearest_request: u64,
    pub tail: u64,
    pub beyond_handlers: u64,
}
