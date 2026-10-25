//! The drain loop and its gas budgeting: what it takes to hand a batch of requests to a handler,
//! and how a caller sizes one.

use alloc::vec::Vec;
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::storage::*;
use thruput_sdk::*;

/// This is the gas that [`Queue::crank`] holds back so the frame can finish once the batch is over:
/// the budget check that ends the drain, the probe that finds the queue empty, releasing the room
/// the batch freed, emitting the batch summary, and whatever the driver itself does after `crank`
/// returns. That last part is the reason this is not a token figure: the reserve is all the gas
/// those have, and a frame that runs out there faults, losing the whole batch it just did.
///
/// The loop checks for `R::GAS_LIMIT + EPILOGUE_GAS` before taking a request, and handling it can
/// spend the whole `R::GAS_LIMIT` (the sub-call is capped there, and unused child gas returns to
/// this frame). What is guaranteed to survive an iteration is therefore `EPILOGUE_GAS` less that
/// iteration's own consume and decode -- and the check runs afresh before each request, so the
/// shortfall is one iteration's, not the batch's.
///
/// Calibrated on a devnode: under the `calibration` feature `crank` reports what it spent beyond
/// the handler calls, which came to about 80k, and this keeps roughly twice that. See
/// `scripts/swap-gas-calibrate.sh`.
///
/// [`Queue::crank`]: crate::Queue::crank
pub const EPILOGUE_GAS: u64 = 200_000;

/// The gas [`Queue::crank`] sets aside for claiming the drain: the commit-locked call its `claim`
/// makes, and the exclusive write that call makes.
///
/// A crank claims only if, with this much paid for the claim, it can still fund what the queue owes
/// -- and at least one request -- so that no crank holds a block's claim without draining. A
/// figure too low would let one through that then drains less than it owes, or nothing; one too
/// high only raises the floor a crank must clear.
///
/// Calibrated on a devnode: under the `calibration` feature `crank` reports what its claim cost,
/// which came to about 43k for `swap-handler`'s, and this keeps roughly twice that. See
/// `scripts/swap-gas-calibrate.sh`.
///
/// [`Queue::crank`]: crate::Queue::crank
pub const CLAIM_GAS: u64 = 100_000;

/// The gas limit a caller should declare in order to have [`Queue::crank`] drain up to `batch_size`
/// requests of type `R`, even if every one of them costs the full [`BatchRequest::GAS_LIMIT`].
///
/// Since the drain is bounded by the gas its frame has left, this is how a caller *chooses* a batch
/// size -- there is no batch size fixed here on everyone's behalf. For a root transaction the
/// figure is also the throughput capacity the scheduler charges against the caller's free native tokens,
/// spent whether or not the batch fills it, so a caller that wants a small encumbrance asks for a
/// small batch.
///
/// Requests usually cost less than their declared worst case, so a real batch often runs longer
/// than `batch_size`. This is a floor, not a cap.
///
/// [`Queue::crank`]: crate::Queue::crank
pub const fn gas_for_batch<R: BatchRequest>(batch_size: u32) -> u64 {
    gas_for(R::GAS_LIMIT, batch_size)
}

/// [`gas_for_batch`], for a crank that orders its batch with a [`Sequencer`] of type `S`; see
/// [`Queue::crank_sequenced`].
///
/// [`Queue::crank_sequenced`]: crate::Queue::crank_sequenced
pub const fn gas_for_sequenced_batch<R: BatchRequest, S: Sequencer>(batch_size: u32) -> u64 {
    gas_for(sequenced_request_gas::<R, S>(), batch_size)
}

const fn gas_for(per_request: u64, batch_size: u32) -> u64 {
    // The claim, and one request's worth beyond what the loop strictly needs, so that a caller
    // declaring exactly this still clears what `crank` requires after the frame's own entry costs.
    budget_for(per_request, batch_size)
        .saturating_add(CLAIM_GAS)
        .saturating_add(per_request)
}

/// The gas a frame must still hold to be able to take `batch_size` more requests of type `R` from
/// here.
///
/// The drain loop's precondition rather than advice to a caller: the check before each request is
/// for one request plus [`EPILOGUE_GAS`], so taking `batch_size` of them in a row needs
/// `batch_size` requests' worth on top of that reserve. [`Queue::crank`] measures a crank against
/// this to decide whether it can fund what the queue owes; a caller sizing a transaction wants
/// [`gas_for_batch`] instead, which leaves room above this for the frame to get as far as its first
/// check.
///
/// [`Queue::crank`]: crate::Queue::crank
pub(crate) const fn budget_for_batch<R: BatchRequest>(batch_size: u32) -> u64 {
    budget_for(R::GAS_LIMIT, batch_size)
}

/// [`budget_for_batch`], for requests that each cost up to `per_request`.
pub(crate) const fn budget_for(per_request: u64, batch_size: u32) -> u64 {
    EPILOGUE_GAS.saturating_add((batch_size as u64).saturating_mul(per_request))
}

/// What a sequenced crank budgets for each request: its handling, plus the sequencer's share.
pub(crate) const fn sequenced_request_gas<R: BatchRequest, S: Sequencer>() -> u64 {
    R::GAS_LIMIT.saturating_add(S::GAS_PER_REQUEST)
}

/// A request that can be batched by a driver.
///
/// This is all a request type must provide for a [`Queue`] to hold and drain it: a way to size each
/// request's gas budget, and the id it was stamped with. (The `WriteXDR`/`ReadXDROwned` bounds are
/// what let it live in the [`RCQ`] behind the queue.)
///
/// [`Queue`]: crate::Queue
pub trait BatchRequest: WriteXDR + ReadXDROwned {
    /// A static upper bound on the gas any single request may consume, used to size a batch. Should
    /// be at least as large as `r.gas_limit()` for any request `r: Self`.
    const GAS_LIMIT: u64;

    /// The gas limit to apply when *this* request is handled.
    fn gas_limit(&self) -> u64;

    /// The id this request was stamped with when it was accepted.
    ///
    /// [`Queue::enqueue`] mints the id and hands it to the request type to carry; this reads it
    /// back. [`Queue::crank`] needs it to name a failed request in its [`RequestFailed`] event, and
    /// must read it *before* handing the request to a handler that consumes it.
    ///
    /// [`Queue::enqueue`]: crate::Queue::enqueue
    /// [`Queue::crank`]: crate::Queue::crank
    /// [`RequestFailed`]: crate::RequestFailed
    fn id(&self) -> SHA256Hash;
}

/// Drain the queue, handing each request to `handle` with the gas budget the request asks for, and
/// return `(n_processed, n_failed)`.
///
/// `handle` performs the actual work for one request (typically a commit-locked, gas-limited call
/// into a handler contract). A failed request does not stop the batch -- the caller is expected to
/// invoke `handle` with commit-locking so a failure rolls back in isolation.
///
/// The batch is bounded by the gas the calling frame has left: it drains until the queue runs dry
/// or the frame can no longer afford another request, and any remainder stays queued for a later
/// call. The caller therefore sizes the batch by its own gas limit -- which, for a root
/// transaction, is exactly the scheduling capacity it has chosen to spend.
///
pub(crate) fn process<R, F, E>(queue: &mut RCQ<R>, mut handle: F) -> (u32, u32)
where
    R: BatchRequest,
    F: FnMut(R, u64) -> Result<(), E>,
    E: core::fmt::Debug,
{
    let mut n_processed = 0;
    let mut n_failed = 0;

    // What this frame must still hold to be worth taking another request: the request's own static
    // worst case, plus enough left over to finish the loop. `saturating_add` keeps a request type
    // with an enormous `GAS_LIMIT` from wrapping the threshold down to something trivially met.
    let per_request_budget = R::GAS_LIMIT.saturating_add(EPILOGUE_GAS);

    // The budget is checked *before* consuming, because a consumed entry cannot be put back: a
    // request must never leave the queue unless this frame can still afford to handle it. The check
    // uses the static `R::GAS_LIMIT` rather than the request's own `gas_limit()`, since the latter
    // is only knowable once the entry is already in hand.
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

/// Chooses the order in which a crank hands its batch to the handler.
///
/// A plain [`Queue::crank`] handles requests in the order the queue yields them. That order is
/// arrival order *between* blocks, but within a block it is just the order of the entries' bytes:
/// fair enough when nothing depends on it, and arbitrary when something does. A sequencer is for a
/// driver whose requests *do* depend on their order -- trades against one pool, each of which
/// moves the price the next one sees -- and wants to choose it by a rule of its own.
///
/// [`Queue::crank_sequenced`] takes the whole batch out of the queue before handling any of it, and
/// shows it to the sequencer, which then picks the requests one at a time by their index in that
/// batch. The queue keeps the requests themselves. However the sequencer picks, every request in
/// the batch is handled exactly once, and a sequencer that picked one twice would abort the crank,
/// putting the whole batch back.
///
/// [`Queue::crank`]: crate::Queue::crank
/// [`Queue::crank_sequenced`]: crate::Queue::crank_sequenced
pub trait Sequencer {
    /// The most gas the sequencer adds to a request's handling: taking it out of the queue and
    /// decoding it, choosing it, and learning how it fared, including any calls it makes to do so.
    /// The crank budgets this much on top of [`BatchRequest::GAS_LIMIT`] for each request.
    const GAS_PER_REQUEST: u64;

    /// The batch index of the next request to handle: one not yet chosen.
    fn next(&mut self) -> usize;

    /// Report how the request just chosen fared: `true` if it was handled, `false` if handling it
    /// failed (and so changed nothing).
    fn handled(&mut self, ok: bool);
}

/// Take a batch out of the queue, have a sequencer order it, and hand each request to `handle` in
/// that order. Return `(n_processed, n_failed)`.
///
/// The batch is as long as the frame can afford, as in [`process`], but the whole of it is
/// affordable *before* the first request is handled: a sequencer has to see the batch to order it.
pub(crate) fn process_sequenced<R, S, F, E>(
    queue: &mut RCQ<R>,
    start: impl FnOnce(&[R]) -> S,
    mut handle: F,
) -> (u32, u32)
where
    R: BatchRequest,
    S: Sequencer,
    F: FnMut(R, u64) -> Result<(), E>,
    E: core::fmt::Debug,
{
    let per_request = sequenced_request_gas::<R, S>();

    #[cfg(feature = "calibration")]
    let mut picks = PickGas::start();

    // As in `process`, a request leaves the queue only once this frame can afford to handle it. A
    // batch taken up front cannot pay as it goes, so each entry taken reserves its whole cost.
    let mut batch = Vec::new();
    let mut reserved = EPILOGUE_GAS;
    while gas_remaining() > reserved.saturating_add(per_request) {
        let Some(request) = queue.try_consume().none_if_missing() else {
            break;
        };
        batch.push(request);
        reserved = reserved.saturating_add(per_request);
    }

    let mut sequencer = start(&batch);
    let mut batch: Vec<Option<R>> = batch.into_iter().map(Some).collect();

    #[cfg(feature = "calibration")]
    picks.setup_done();

    let mut n_failed = 0;
    for _ in 0..batch.len() {
        #[cfg(feature = "calibration")]
        picks.step();

        let request = batch[sequencer.next()]
            .take()
            .expect("a sequencer chooses each request once");

        #[cfg(feature = "calibration")]
        picks.pause();

        let gas_limit = request.gas_limit();
        let result = handle(request, gas_limit);
        if let Err(e) = &result {
            request_failed(e);
            n_failed += 1;
        }

        #[cfg(feature = "calibration")]
        picks.resume();

        sequencer.handled(result.is_ok());
    }

    #[cfg(feature = "calibration")]
    picks.report(batch.len() as u32);

    (batch.len() as u32, n_failed)
}

/// What a sequencer or lane picker spent in one crank, measured on the node that ran it, to set
/// [`Sequencer::GAS_PER_REQUEST`] and [`LanePicker::GAS_PER_REQUEST`] from.
///
/// Emitted only under the `calibration` feature, alongside the crank's [`GasReport`]. `setup` is
/// what the crank spent before its first step on the picker's account: taking a sequenced batch out
/// of the queue and building its sequencer, or finding which lanes hold requests. A step is
/// everything spent on one request outside its handler call: choosing it, taking it, and telling
/// the picker how it fared; `dearest_step` is the most one cost, and `steps` all of them together.
///
/// A sequenced crank fixes its batch up front, so what must fit is the whole of `setup + steps`
/// within `processed` requests' allowance. A laned crank checks its budget before each step, so
/// what must fit is `dearest_step`.
///
/// [`GasReport`]: crate::GasReport
/// [`LanePicker::GAS_PER_REQUEST`]: crate::LanePicker::GAS_PER_REQUEST
#[cfg(feature = "calibration")]
#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct PickReport {
    pub processed: u32,
    pub setup: u64,
    pub dearest_step: u64,
    pub steps: u64,
}

/// Running totals for a [`PickReport`].
#[cfg(feature = "calibration")]
pub(crate) struct PickGas {
    // Where the current stretch of counting began.
    mark: u64,
    setup: u64,
    // The step under way, if any, and what it has spent so far.
    step: Option<u64>,
    dearest_step: u64,
    steps: u64,
}

#[cfg(feature = "calibration")]
impl PickGas {
    pub(crate) fn start() -> Self {
        PickGas {
            mark: gas_remaining(),
            setup: 0,
            step: None,
            dearest_step: 0,
            steps: 0,
        }
    }

    pub(crate) fn setup_done(&mut self) {
        self.setup = self.mark.saturating_sub(gas_remaining());
    }

    // Close the step under way, if any, and open the next.
    pub(crate) fn step(&mut self) {
        self.close_step();
        self.step = Some(0);
        self.mark = gas_remaining();
    }

    // Stop counting, for a handler call.
    pub(crate) fn pause(&mut self) {
        let since = self.mark.saturating_sub(gas_remaining());
        self.step = self.step.map(|s| s.saturating_add(since));
    }

    pub(crate) fn resume(&mut self) {
        self.mark = gas_remaining();
    }

    pub(crate) fn report(mut self, processed: u32) {
        self.close_step();
        log_event(&PickReport {
            processed,
            setup: self.setup,
            dearest_step: self.dearest_step,
            steps: self.steps,
        });
    }

    fn close_step(&mut self) {
        if let Some(step) = self.step.take() {
            let step = step.saturating_add(self.mark.saturating_sub(gas_remaining()));
            self.dearest_step = self.dearest_step.max(step);
            self.steps = self.steps.saturating_add(step);
        }
    }
}

fn request_failed<E: core::fmt::Debug>(_e: &E) {
    #[cfg(feature = "dev")]
    println!("!! request failed: {_e:?}");

    // TODO: emit event
}
