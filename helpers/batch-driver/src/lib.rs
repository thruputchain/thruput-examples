//! Reusable core for the request-batching driver pattern.
//!
//! A *driver* contract accepts requests into a queue (so they can be enqueued
//! concurrently), and later drains that queue, handling each request in
//! isolation.
//!
//! This crate captures the part of that pattern that is independent of *what*
//! the requests are: the drain-and-handle loop, its gas budgeting, and its
//! failure accounting.
//!
//! A contract's exported entrypoints are concrete (they decode fixed argument
//! types), so the concrete request type has to be named by the crate that
//! produces the contract.  Therefore each driver contract owns its queue, and
//! delegates its processing loop to this crate's [`process`]:
//!
//! ```ignore
//! pub fn process_requests(&mut self) -> (u32, u32) {
//!     let cfg = self.cfg.get();
//!     batch_driver::process(&mut self.requests, |request, gas_limit| {
//!         cfg.handler()
//!             .with_commit_locking()
//!             .with_gas_limit(gas_limit)
//!             .try_handle_request(request)
//!     })
//! }
//! ```
//!
//! ## Draining belongs in a transaction of its own
//!
//! It is tempting to let a request submission drain the queue on its way past,
//! sparing the caller a second transaction.  Two properties of the queue make
//! that a bad trade:
//!
//! * A drain does not see the requests its own block ordered after it, so a
//!   combined transaction usually would not serve its own request anyway.
//! * Only one transaction per block may consume from a queue.  A combined
//!   transaction that loses that race is excluded whole -- taking its request
//!   submission down with it, and so delaying exactly the request whose caller
//!   was trying to hurry it along.
//!
//! Keeping the two apart also keeps the drain's declared gas limit -- and thus
//! the throughput capacity it encumbers -- independent of the request's.
//!
//! ## Who drains, and when
//!
//! Draining needs no privilege, so anyone may do it, and the policy that falls
//! out of the queue's own rules is about as simple as a policy gets: after
//! submitting a request, send a drain as its own transaction, sized to the
//! batch you are willing to fund and given a short expiry height.  Then stop.
//!
//! Nothing needs to be polled, estimated, or timed, because each way a drain
//! can turn out is already harmless:
//!
//! * Another drain won the block.  Yours is excluded and returned to the
//!   mempool, and lands in a later block on its own.
//! * The queue was empty at the block's snapshot.  Yours commits having done
//!   nothing, writing no delta and conflicting with nobody.
//! * Otherwise it drains, up to the batch its gas limit bought.
//!
//! The short expiry is what keeps the first case from turning into a nuisance:
//! a drain that loses several blocks running should give up rather than land
//! much later as a pointless no-op.
//!
//! Batching does not have to be arranged for.  Only one drain per block can
//! commit, so any arrival rate faster than that builds a queue by itself, and
//! the next drain takes what accumulated.  A driver that waited for a queue to
//! grow "ripe" before draining would only be adding latency to a batch the
//! next block would have taken anyway.
//!
//! An operator's own queue-keeper, if desired, composes with this without any
//! mode switch: while it runs it wins each block and everyone else's drains
//! defer harmlessly behind it; if it stops, theirs start winning the very next
//! block.  Nobody has to detect which of those is happening.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::stats::gas_remaining;
use sdk::storage::*;
use sdk::*;

/// Gas [`process`] holds back so that the frame can finish once the batch is
/// over: the budget check that ends the loop, the probe that finds the queue
/// empty, returning the counts -- **and whatever the driver itself does after
/// `process` returns**, which for `swap-driver` is releasing the queue's room
/// and emitting its batch summary.  That last part is the reason this is not a
/// token figure: the reserve is all the gas those have, and a frame that runs
/// out there faults, losing the whole batch it just did.
///
/// The loop checks for `R::GAS_LIMIT + EPILOGUE_GAS` before taking a request,
/// and handling it can spend the whole `R::GAS_LIMIT` (the sub-call is capped
/// there, and unused child gas returns to this frame).  What is guaranteed to
/// survive an iteration is therefore `EPILOGUE_GAS` less that iteration's own
/// consume and decode -- and the check runs afresh before each request, so the
/// shortfall is one iteration's, not the batch's.
///
/// Loose, like the per-request figures a [`BatchRequest`] declares.  Measured
/// against the guest build by `swap-driver`'s `epilogue_gas` test, which holds
/// this at several times a crank's fixed cost: at the time of writing that
/// cost was ~12.3k gas, of which ~5.4k was the driver's own tail.  Being
/// generous is nearly free -- at `swap-driver`'s figures this is under a tenth
/// of one request's declared budget -- and costs a caller nothing beyond
/// occasionally leaving one last request queued for the next crank.
pub const EPILOGUE_GAS: u64 = 50_000;

/// The gas limit a caller should declare to have [`process`] drain up to
/// `batch_size` requests of type `R`, even if every one of them costs the full
/// [`BatchRequest::GAS_LIMIT`].
///
/// Since the drain is bounded by the gas its frame has left, this is how a
/// caller *chooses* a batch size -- there is no batch size fixed here on
/// everyone's behalf.  For a root transaction the figure is also the throughput
/// capacity the scheduler charges against the caller's free HOG, spent whether
/// or not the batch fills it, so a caller that wants a small encumbrance asks
/// for a small batch.
///
/// Requests usually cost less than their declared worst case, so a real batch
/// often runs longer than `batch_size`.  This is a floor, not a cap.
pub const fn gas_for_batch<R: BatchRequest>(batch_size: u32) -> u64 {
    // One request's worth beyond what the loop strictly needs, so that a
    // caller declaring exactly this still clears [`budget_for_batch`] after
    // the frame's own entry costs.
    budget_for_batch::<R>(batch_size).saturating_add(R::GAS_LIMIT)
}

/// The gas a frame must still hold for [`process`] to be able to take
/// `batch_size` more requests of type `R` from here.
///
/// This is the loop's precondition rather than advice to a caller: the check
/// before each request is for one request plus [`EPILOGUE_GAS`], so taking
/// `batch_size` of them in a row needs `batch_size` requests' worth on top of
/// that reserve.  A caller sizing a transaction wants
/// [`gas_for_batch`] instead, which leaves room above this for the frame to
/// get as far as its first check.
///
/// A driver can use this to refuse a crank too small to be worth the block's
/// one drain -- see [`Slots::remaining_at_snapshot`].
pub const fn budget_for_batch<R: BatchRequest>(batch_size: u32) -> u64 {
    EPILOGUE_GAS.saturating_add((batch_size as u64).saturating_mul(R::GAS_LIMIT))
}

/// Admission control for a driver's queue: the room still left in it.
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
/// # Example
///
/// ```ignore
/// #[storage]
/// pub struct Driver {
///     requests: RCQ<Request>,
///     ids: Node<UniqueState>,
/// }
///
/// fn request(&mut self, request: Request) -> SHA256Hash {
///     let id = self.ids.next_id();
///     self.requests.insert(&request.with_id(id));
///     id
/// }
/// ```
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

/// A request that can be batched by a driver.
///
/// This is all a request type must provide for [`process`] to drive it: a way
/// to size each request's gas budget.  (The `WriteXDR`/`ReadXDROwned` bounds are
/// what let it live in the driver's [`RCQ`] queue.)
///
pub trait BatchRequest: WriteXDR + ReadXDROwned {
    /// A static upper bound on the gas any single request may consume, used to
    /// size a batch.  Should be at least as large as `r.gas_limit()` for any
    /// request `r: Self`.
    const GAS_LIMIT: u64;

    /// The gas limit to apply when *this* request is handled.
    fn gas_limit(&self) -> u64;
}

/// Drain the queue, handing each request to `handle` with the gas budget the
/// request asks for, and return `(n_processed, n_failed)`.
///
/// `handle` performs the actual work for one request (typically a
/// commit-locked, gas-limited call into a handler contract).  A failed request
/// does not stop the batch -- the caller is expected to invoke `handle` with
/// commit-locking so a failure rolls back in isolation.
///
/// The batch is bounded by the gas the calling frame has left: it drains until
/// the queue runs dry or the frame can no longer afford another request, and
/// any remainder stays queued for a later call.  The caller therefore sizes the
/// batch by its own gas limit -- which, for a root transaction, is exactly the
/// scheduling capacity it has chosen to spend.
///
pub fn process<R, F, E>(queue: &mut RCQ<R>, mut handle: F) -> (u32, u32)
where
    R: BatchRequest,
    F: FnMut(R, u64) -> Result<(), E>,
    E: core::fmt::Debug,
{
    let mut n_processed = 0;
    let mut n_failed = 0;

    // What this frame must still hold to be worth taking another request: the
    // request's own static worst case, plus enough left over to finish the
    // loop.  `saturating_add` keeps a request type with an enormous
    // `GAS_LIMIT` from wrapping the threshold down to something trivially met.
    let per_request_budget = R::GAS_LIMIT.saturating_add(EPILOGUE_GAS);

    // The budget is checked *before* consuming, because a consumed entry
    // cannot be put back: a request must never leave the queue unless this
    // frame can still afford to handle it.  The check uses the static
    // `R::GAS_LIMIT` rather than the request's own `gas_limit()`, since the
    // latter is only knowable once the entry is already in hand.
    while gas_remaining() > per_request_budget {
        let Some(request) = queue.try_consume().none_if_missing() else {
            break;
        };

        // Each request knows how much gas its handling deserves.
        let gas_limit = request.gas_limit();

        if let Err(e) = handle(request, gas_limit) {
            request_failed(&e);
            n_failed += 1;
        }

        n_processed += 1;
    }

    (n_processed, n_failed)
}

fn request_failed<E: core::fmt::Debug>(_e: &E) {
    #[cfg(feature = "dev")]
    println!("!! request failed: {_e:?}");

    // TODO: emit event
}
