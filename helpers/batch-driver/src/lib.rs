//! Reusable core for the request-batching driver pattern.
//!
//! A *driver* contract accepts requests into a queue (so they can be enqueued
//! concurrently), and later drains that queue, handling each request in
//! isolation.
//!
//! This crate captures the part of that pattern that is independent of *what*
//! the requests are: admission control, the ids stamped on accepted requests,
//! the minimum allowed batch size, the drain-and-handle loop with its gas
//! budgeting and failure accounting, and the three events that narrate all of
//! it -- [`RequestAccepted`], [`RequestFailed`] and [`RequestsProcessed`].
//! [`Queue`] holds all of it, and emits those events itself, so every driver
//! built on it reports its queue the same way.
//!
//! A driver holds a `Queue<R>` of the request type `R` that it defines, and
//! "cranks" the queue by providing a request-handling closure:
//!
//! ```ignore
//! pub fn process_requests(&mut self) -> (u32, u32) {
//!     let cfg = self.cfg.get();
//!     self.queue
//!         .crank(|request, gas_limit| {
//!             cfg.handler()
//!                 .with_commit_locking()
//!                 .with_gas_limit(gas_limit)
//!                 .try_handle_request(request)
//!         })
//!         .unwrap_or_else(|_| throw(MyError::BatchTooSmall))
//! }
//! ```
//!
//! In order for interfacing software to understand the events emitted by the
//! batching library, they should be listed in the driver contract's
//! `emits(...)` list:
//!
//! ```ignore
//! #[contract(
//!     client = MyDriverClient,
//!     emits(
//!         batch_driver::RequestAccepted,
//!         batch_driver::RequestFailed,
//!         batch_driver::RequestsProcessed
//!     )
//! )]
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
//! * Otherwise it drains, up to the batch-size its gas limit allows.
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

/// This is the gas that [`Queue::crank`] holds back so the frame can finish
/// once the batch is over: the budget check that ends the drain, the probe
/// that finds the queue empty, releasing the room the batch freed, emitting
/// the batch summary, and whatever the driver itself does after `crank`
/// returns.  That last part is the reason this is not a token figure: the
/// reserve is all the gas those have, and a frame that runs out there faults,
/// losing the whole batch it just did.
///
/// The loop checks for `R::GAS_LIMIT + EPILOGUE_GAS` before taking a request,
/// and handling it can spend the whole `R::GAS_LIMIT` (the sub-call is capped
/// there, and unused child gas returns to this frame).  What is guaranteed to
/// survive an iteration is therefore `EPILOGUE_GAS` less that iteration's own
/// consume and decode -- and the check runs afresh before each request, so the
/// shortfall is one iteration's, not the batch's.
pub const EPILOGUE_GAS: u64 = 50_000;

/// The gas limit a caller should declare in order to have [`Queue::crank`]
/// drain up to `batch_size` requests of type `R`, even if every one of them
/// costs the full [`BatchRequest::GAS_LIMIT`].
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
    // caller declaring exactly this still clears `budget_for_batch` after the
    // frame's own entry costs.
    budget_for_batch::<R>(batch_size).saturating_add(R::GAS_LIMIT)
}

/// The gas a frame must still hold to be able to take `batch_size` more
/// requests of type `R` from here.
///
/// The drain loop's precondition rather than advice to a caller: the check
/// before each request is for one request plus [`EPILOGUE_GAS`], so taking
/// `batch_size` of them in a row needs `batch_size` requests' worth on top of
/// that reserve.  [`Queue::crank`] measures a crank against this to decide
/// whether it can fund what the queue owes; a caller sizing a transaction
/// wants [`gas_for_batch`] instead, which leaves room above this for the frame
/// to get as far as its first check.
const fn budget_for_batch<R: BatchRequest>(batch_size: u32) -> u64 {
    EPILOGUE_GAS.saturating_add((batch_size as u64).saturating_mul(R::GAS_LIMIT))
}

/// Admission control for a driver's queue: the room still left in it.
///
/// (This is used interally by [`Queue`], but is available for other uses by
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
#[derive(Storage)]
struct UniqueState {
    seq: NNInt,
}

impl UniqueState {
    /// Mint an id no other request has been given.
    fn next_id(&mut self) -> SHA256Hash {
        self.seq.inc(1);
        (get_source_transaction_hash(), self.seq.get()).hash()
    }
}

/// A request that can be batched by a driver.
///
/// This is all a request type must provide for a [`Queue`] to hold and drain
/// it: a way to size each request's gas budget, and the id it was stamped
/// with.  (The `WriteXDR`/`ReadXDROwned` bounds are what let it live in the
/// [`RCQ`] behind the queue.)
///
pub trait BatchRequest: WriteXDR + ReadXDROwned {
    /// A static upper bound on the gas any single request may consume, used to
    /// size a batch.  Should be at least as large as `r.gas_limit()` for any
    /// request `r: Self`.
    const GAS_LIMIT: u64;

    /// The gas limit to apply when *this* request is handled.
    fn gas_limit(&self) -> u64;

    /// The id this request was stamped with when it was accepted.
    ///
    /// [`Queue::enqueue`] mints the id and hands it to the request type to
    /// carry; this reads it back.  [`Queue::crank`] needs it to name a failed
    /// request in its [`RequestFailed`] event, and must read it *before*
    /// handing the request to a handler that consumes it.
    fn id(&self) -> SHA256Hash;
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
fn process<R, F, E>(queue: &mut RCQ<R>, mut handle: F) -> (u32, u32)
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

/// How much of a failed request's exception payload [`RequestFailed`] carries.
///
/// The protocol caps a whole serialized event at 1024 bytes, topics included,
/// and an abort payload at the same figure on its own -- so a verbatim copy
/// cannot be guaranteed to fit, and an oversized event *throws*, which inside
/// a crank would abort the batch and lose the requests that had already
/// succeeded.  The payload is therefore truncated, and this is the ceiling
/// [`RequestFailed::of`] truncates to.
///
/// Not set at that ceiling, though, and not for want of room: the payload is
/// variable-length on the wire, so a short one costs its own few bytes however
/// high this is set, and raising it is free for every failure that does not
/// use it.  Two things argue against the brim anyway.
///
/// The first is that the margin is what protects the batch.  A maximal event
/// currently serializes well inside the cap; a field added to
/// [`RequestFailed`] eats that margin, and at the brim it would push every
/// large-payload failure over -- aborting batches, and only once an exception
/// large enough actually occurred.  `tests/event_budget.rs` pins both the fit
/// and the margin so that lands in CI instead.
///
/// The second is that these are emitted per request, so a batch multiplies
/// them: a queue that fails wholesale emits one for every entry it held.  The
/// worst case is this figure times the queue's capacity, which is worth
/// keeping modest for something read far more often than it is needed.
///
/// And the need is small.  An exception payload leads with its variant
/// discriminant, so four bytes already name the variant of any fieldless
/// error, which is nearly all of them; the largest in the swap suite is eight.
/// [`RequestFailed::payload_len`] reports the untruncated length, so a reader
/// can always tell when there was more.
pub const EXCEPTION_PAYLOAD_MAX: usize = 256;

/// How a request's handling failed, for [`RequestFailed`].
///
/// A [`CallError`] has ten variants, but only one of them carries an
/// exception.  The rest still have to be told apart, because they mean
/// different things to whoever has to fix them: a fault is the handler
/// running out of the gas the request declared (or panicking); a rejection is
/// a mis-wired driver; a malformed result is interface skew between the two.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cause {
    /// The handler aborted with a selector-tagged error.  This is the only
    /// cause for which [`RequestFailed`]'s `selector` and `payload` say
    /// anything.
    Exception = 1,

    /// The handler's frame died without a result: it exhausted the gas the
    /// request declared, panicked, or trapped.  Nothing crosses a faulted
    /// call boundary, so there is nothing to report but the fact.
    Fault = 2,

    /// The call was refused before the handler ran at all -- no contract at
    /// the address, a reentrant call, or the invocation depth bound.
    Rejected = 3,

    /// The call completed but its result would not decode, on one side or the
    /// other.
    Malformed = 4,
}

/// Emitted by [`Queue::enqueue`] when a request is accepted, carrying the id
/// it was stamped with.
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestAccepted<'a> {
    #[topic]
    pub request_id: &'a SHA256Hash,
}

/// Emitted by [`Queue::crank`] for each request whose handling failed.
///
/// The payload is the exception's own wire bytes, truncated to
/// [`EXCEPTION_PAYLOAD_MAX`] and borrowed rather than copied.  With the `selector`
/// it is enough to name the error: a contract's spec maps a selector to the
/// exception type it belongs to, and that type's definition maps the leading
/// payload bytes to a variant -- so an observer decodes one of these from the
/// generated bindings alone, with nothing further to arrange.
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestFailed<'a> {
    #[topic]
    pub request_id: &'a SHA256Hash,

    /// Which kind of failure this was, and so whether the two fields below
    /// mean anything.
    pub cause: Cause,

    /// The exception type's selector, or zero when `cause` is not
    /// [`Cause::Exception`].
    pub selector: u64,

    /// The leading bytes of the exception's payload, at most
    /// [`EXCEPTION_PAYLOAD_MAX`] of them.
    pub payload: &'a [u8],

    /// The payload's length before truncation, so a reader can tell that
    /// there was more than `payload` holds.
    pub payload_len: u32,
}

impl<'a> RequestFailed<'a> {
    /// Describe `e` as a failure of the request `request_id`, borrowing the
    /// exception's payload in place.
    pub fn of(request_id: &'a SHA256Hash, e: &'a CallError) -> Self {
        let (cause, selector, bytes): (Cause, u64, &'a [u8]) = match e {
            CallError::Exception(exn) => (Cause::Exception, exn.selector(), exn.payload()),
            CallError::Fault(_) => (Cause::Fault, 0, &[]),
            e if e.is_rejected_before_call() => (Cause::Rejected, 0, &[]),
            _ => (Cause::Malformed, 0, &[]),
        };

        Self {
            request_id,
            cause,
            selector,
            payload: &bytes[..bytes.len().min(EXCEPTION_PAYLOAD_MAX)],
            payload_len: bytes.len() as u32,
        }
    }
}

/// Emitted by [`Queue::crank`] once for a batch that processed anything.
///
/// A crank that found the queue empty emits nothing: it writes no delta and
/// has nothing to report, which is what keeps an unlucky crank free rather
/// than a nuisance.
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct RequestsProcessed {
    /// How many requests left the queue, failures included.
    pub processed: u32,

    /// How many of those failed, each with its own [`RequestFailed`].
    pub failed: u32,
}

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
    ids: Node<UniqueState>,

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
