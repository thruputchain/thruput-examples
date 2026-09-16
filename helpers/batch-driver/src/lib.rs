//! Reusable core for the request-batching driver pattern.
//!
//! A *driver* contract accepts requests into a queue (so they can be enqueued concurrently), and
//! later drains that queue, handling each request in isolation.
//!
//! This crate captures the part of that pattern that is independent of *what* the requests are:
//! admission control, the ids stamped on accepted requests, the minimum allowed batch size, the
//! drain-and-handle loop with its gas budgeting and failure accounting, and the three events that
//! narrate all of it -- [`RequestAccepted`], [`RequestFailed`] and [`RequestsProcessed`]. [`Queue`]
//! holds all of it, and emits those events itself, so every driver built on it reports its queue
//! the same way.
//!
//! A driver holds a `Queue<R>` of the request type `R` that it defines, and "cranks" the queue by
//! providing a request-handling closure:
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
//! second transaction. Two properties of the queue make that a bad trade:
//!
//! * A drain does not see the requests its own block ordered after it, so a combined transaction
//!   usually would not serve its own request anyway.
//! * Only one transaction per block may consume from a queue. A combined transaction that loses
//!   that race is excluded whole -- taking its request submission down with it, and so delaying
//!   exactly the request whose caller was trying to hurry it along.
//!
//! Keeping the two apart also keeps the drain's declared gas limit -- and thus the throughput
//! capacity it encumbers -- independent of the request's.
//!
//! ## Who drains, and when
//!
//! Draining needs no privilege, so anyone may do it, and the policy that falls out of the queue's
//! own rules is about as simple as a policy gets: after submitting a request, send a drain as its
//! own transaction, sized to the batch you are willing to fund and given a short expiry height.
//! Then stop.
//!
//! Nothing needs to be polled, estimated, or timed, because each way a drain can turn out is
//! already harmless:
//!
//! * Another drain won the block. Yours is excluded and returned to the mempool, and lands in a
//!   later block on its own.
//! * The queue was empty at the block's snapshot. Yours commits having done nothing, writing no
//!   delta and conflicting with nobody.
//! * Otherwise it drains, up to the batch-size its gas limit allows.
//!
//! The short expiry is what keeps the first case from turning into a nuisance: a drain that loses
//! several blocks running should give up rather than land much later as a pointless no-op.
//!
//! Batching does not have to be arranged for. Only one drain per block can commit, so any arrival
//! rate faster than that builds a queue by itself, and the next drain takes what accumulated. A
//! driver that waited for a queue to grow "ripe" before draining would only be adding latency to a
//! batch the next block would have taken anyway.
//!
//! An operator's own queue-keeper, if one is desired, composes with this without any mode switch:
//! while it runs it wins each block and everyone else's drains defer harmlessly behind it; if it
//! stops, theirs start winning the very next block. Nobody has to detect which of those is
//! happening.

#![cfg_attr(not(feature = "dev"), no_std)]

mod drain;
mod events;
mod queue;

pub use drain::{BatchRequest, EPILOGUE_GAS, gas_for_batch};
pub use events::{Cause, EXCEPTION_PAYLOAD_MAX, RequestAccepted, RequestFailed, RequestsProcessed};
#[cfg(feature = "calibration")]
pub use queue::GasReport;
pub use queue::{CrankPolicy, InvalidPolicy, Queue, Starved};
