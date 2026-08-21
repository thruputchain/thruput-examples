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

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::stats::gas_remaining;
use sdk::storage::*;
use sdk::*;

/// Gas [`process`] holds back for the loop's own epilogue: the budget check
/// that ends it, the probe that finds the queue empty, and returning the
/// counts.
///
/// Loose, like the per-request figures a [`BatchRequest`] declares.  It only
/// has to be an over-estimate -- being generous costs a caller nothing beyond
/// occasionally leaving one last request queued for the next crank.
pub const EPILOGUE_GAS: u64 = 10_000;

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
    // One request's worth beyond the batch: `process` checks for room for a
    // whole request *before* taking one, so draining the last request of a
    // full batch requires that much still on hand.
    let requests = (batch_size as u64).saturating_add(1);

    EPILOGUE_GAS.saturating_add(requests.saturating_mul(R::GAS_LIMIT))
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
