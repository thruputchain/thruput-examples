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

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::*;
use sdk::*;

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
/// The batch stops once its cumulative gas budget would exceed roughly ten
/// requests' worth ([`BatchRequest::GAS_LIMIT`] each); any remainder stays
/// queued for a later call.
///
pub fn process<R, F, E>(queue: &mut RCQ<R>, mut handle: F) -> (u32, u32)
where
    R: BatchRequest,
    F: FnMut(R, u64) -> Result<(), E>,
    E: core::fmt::Debug,
{
    // Allow about 10 requests per batch.
    let batch_gas_high_water = 9 * R::GAS_LIMIT;

    let mut n_processed = 0;
    let mut n_failed = 0;
    let mut batch_gas_consumed_max = 0u64;

    while let Some(request) = queue.try_consume().none_if_missing() {
        // Each request knows how much gas its handling deserves.
        let gas_limit = request.gas_limit();

        if let Err(e) = handle(request, gas_limit) {
            request_failed(&e);
            n_failed += 1;
        }

        batch_gas_consumed_max += gas_limit;
        n_processed += 1;

        if batch_gas_consumed_max > batch_gas_high_water {
            break;
        }
    }

    (n_processed, n_failed)
}

fn request_failed<E: core::fmt::Debug>(_e: &E) {
    #[cfg(feature = "dev")]
    println!("!! request failed: {_e:?}");

    // TODO: emit event
}
