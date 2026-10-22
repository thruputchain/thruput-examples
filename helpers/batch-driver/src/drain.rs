//! The drain loop and its gas budgeting: what it takes to hand a batch of requests to a handler,
//! and how a caller sizes one.

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
    // One request's worth beyond what the loop strictly needs, so that a caller declaring exactly
    // this still clears `budget_for_batch` after the frame's own entry costs.
    budget_for_batch::<R>(batch_size).saturating_add(R::GAS_LIMIT)
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
    EPILOGUE_GAS.saturating_add((batch_size as u64).saturating_mul(R::GAS_LIMIT))
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

fn request_failed<E: core::fmt::Debug>(_e: &E) {
    #[cfg(feature = "dev")]
    println!("!! request failed: {_e:?}");

    // TODO: emit event
}
