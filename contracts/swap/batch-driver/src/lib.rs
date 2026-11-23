//! Reusable core for the request-batching driver pattern.
//!
//! A *driver* contract accepts requests into a queue (so they can be enqueued concurrently), and
//! later drains that queue, handling each request in isolation.
//!
//! This crate captures the part of that pattern that is independent of
//! particular request types: admission control, the drain-and-handle loop with
//! its gas budgeting and failure accounting, and events.
//!
//! A driver holds a `Queue<R>` of the request type `R` that it defines, and "cranks" the queue by
//! providing a request-handling closure:
//!
//! ```ignore
//! pub fn process_requests(&mut self) -> (u32, u32) {
//!     let cfg = self.cfg.get();
//!     self.queue
//!         .crank(
//!             || cfg.handler().with_commit_locking().try_claim_crank(),
//!             |request, gas_limit| {
//!                 cfg.handler()
//!                     .with_commit_locking()
//!                     .with_gas_limit(gas_limit)
//!                     .try_handle_request(request)
//!             },
//!         )
//!         .unwrap_or_else(|_| throw(MyError::BatchTooSmall))
//! }
//! ```
//!
//! In order for interfacing software to understand the events emitted by the batching library, they
//! should be listed in the driver contract's `emits(...)` list:
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
//! It is tempting to let a request submission drain the queue on its way past, sparing the caller a
//! second transaction. But a drain does not see the requests its own block ordered after it, so a
//! combined transaction usually would not serve its own request anyway. Keeping the two apart also
//! keeps the drain's declared gas limit, and thus the throughput capacity it encumbers,
//! independent of the request's.
//!
//! ## Who drains, and when
//!
//! Draining needs no privilege, so anyone may do it, and the policy that falls out of the queue's
//! own rules is about as simple as a policy gets: after a request has committed, send a drain as
//! its own transaction, sized to the batch you are willing to fund. If the request is still
//! waiting once that drain has landed, send another.
//!
//! Nothing needs to be estimated or timed, because each way a drain can turn out is harmless:
//!
//! * Another drain claimed the block first. Yours finds its claim refused, and commits having
//!   done nothing; the winner, which saw the same queue, drains it.
//! * There was nothing to drain. Yours commits without writing a delta or causing conflicts.
//! * Otherwise it claims the block and drains, up to the batch-size its gas limit allows.
//!
//! The claim is what makes the first case harmless; see [`Queue::crank`].
//!
//! Batching does not have to be arranged for. Only one drain per block can commit, so any arrival
//! rate faster than that builds a queue by itself, and the next drain takes what accumulated.
//!
//! An operator's own queue-keeper, if one is desired, composes with this without any mode switch:
//! while it runs, it claims each block and everyone else's drains find nothing left to do; if it
//! stops, theirs start winning in the very next block. Nobody has to detect which of those is
//! happening.

#![cfg_attr(not(feature = "dev"), no_std)]

mod drain;
mod events;
mod queue;

pub use drain::{BatchRequest, CLAIM_GAS, EPILOGUE_GAS, gas_for_batch};
pub use events::{Cause, EXCEPTION_PAYLOAD_MAX, RequestAccepted, RequestFailed, RequestsProcessed};
#[cfg(feature = "calibration")]
pub use queue::GasReport;
pub use queue::{CrankPolicy, InvalidPolicy, Queue, Starved};
