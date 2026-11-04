//! The driver's queue: a `batch_driver::Queue`, drained by a crank that takes its batch whole and
//! has [`Clvr`] order it.
//!
//! CLVR places each trade by comparing it with every other trade not yet placed, so it has to see
//! the whole batch before handling any of it. A plain `Queue::crank` hands requests to the handler
//! as it takes them, so this queue keeps its own crank: it takes the batch out of the queue first,
//! then hands it over in the order CLVR chooses.
//!
//! Everything else is as for a `batch_driver::Queue`, and built from the same parts: the ceiling,
//! the floor a crank owes, the claim, the isolation of each request's failure, and the events.

use crate::clvr::{Clvr, MAX_BATCH, SEQUENCE_GAS};
use alloc::vec::Vec;
use batch_driver::{
    BatchRequest, CLAIM_GAS, CrankPolicy, EPILOGUE_GAS, InvalidPolicy, RequestAccepted,
    RequestFailed, RequestsProcessed, Starved,
};
use swap_if::{Amounts, SwapRequest};
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::storage::*;
use thruput_sdk::*;
use unique_ids::UniqueIds;

/// What a crank budgets for each request: its handling's worst case, plus the ordering's share.
const PER_REQUEST: u64 = SwapRequest::GAS_LIMIT.saturating_add(SEQUENCE_GAS);

/// `batch_driver::gas_for_batch`, for this queue's crank.
pub const fn gas_for_batch(batch_size: u32) -> u64 {
    budget(batch_size)
        .saturating_add(CLAIM_GAS)
        .saturating_add(PER_REQUEST)
}

// The gas a frame must still hold to take `batch_size` more requests, as in `batch_driver`'s drain.
const fn budget(batch_size: u32) -> u64 {
    EPILOGUE_GAS.saturating_add((batch_size as u64).saturating_mul(PER_REQUEST))
}

/// The driver's request queue; see the module docs.
#[derive(Storage)]
pub struct Queue {
    // The entries, which concurrent transactions insert into.
    requests: RCQ<SwapRequest>,

    // The remaining capacity of the queue; see `batch_driver::Queue`.
    slots: CapacityConstraint,

    // The source of the id stamped on each accepted entry.
    ids: Node<UniqueIds>,

    policy: Value<CrankPolicy>,
}

impl Queue {
    /// Set the queue's policy. Call once, when the driver is initialized; see
    /// `batch_driver::Queue::initialize`.
    pub fn initialize(&mut self, policy: CrankPolicy) -> Result<(), InvalidPolicy> {
        if policy.min_batch > policy.capacity {
            return Err(InvalidPolicy);
        }

        self.policy.set(&policy);
        self.slots.set_capacity(i128::from(policy.capacity));

        Ok(())
    }

    /// Accept one entry, returning the id stamped on it; see `batch_driver::Queue::enqueue`.
    pub fn enqueue(&mut self, stamp: impl FnOnce(SHA256Hash) -> SwapRequest) -> SHA256Hash {
        // As in `Queue::enqueue`: not checked here, so that an enqueue arriving at a full queue
        // fails at commit, with nothing written.
        self.slots.consume_capacity(1);

        let id = self.ids.next_id();
        self.requests.insert(&stamp(id));

        log_event(&RequestAccepted { request_id: &id });

        id
    }

    /// Take a batch out of the queue, order it by CLVR against the reserves `read_reserves`
    /// reports, and hand each request to `handle` in that order; return `(n_processed, n_failed)`.
    ///
    /// The floor, the refusal and the claim are as in `batch_driver::Queue::crank`, with each
    /// request costing its worst case plus [`SEQUENCE_GAS`]. The batch is as long as the frame can
    /// afford, up to [`MAX_BATCH`]; size a call with [`gas_for_batch`]. Which requests make up the
    /// batch is still the queue's: the first it yields, so however CLVR orders them, no request
    /// waits behind one admitted in a later block.
    pub fn crank<C, F>(
        &mut self,
        claim: C,
        read_reserves: impl FnMut() -> Amounts,
        mut handle: F,
    ) -> Result<(u32, u32), Starved>
    where
        C: FnOnce() -> Result<(), CallError>,
        F: FnMut(SwapRequest, u64) -> Result<(), CallError>,
    {
        #[cfg(feature = "calibration")]
        let entry_gas = gas_remaining();

        let policy = self.policy.get();
        let capacity = i128::from(policy.capacity);
        // How deep the queue was at this block's snapshot. (The remaining capacity can read
        // negative mid-transaction.)
        let queued = (capacity - self.slots.get_remaining_capacity()).clamp(0, capacity) as u32;
        // A crank owes no more than it may take.
        let owed = queued.min(policy.min_batch).min(MAX_BATCH);

        // Nothing to drain, so nothing to claim.
        if self.requests.try_peek().none_if_missing().is_none() {
            return Ok((0, 0));
        }

        // As in `Queue::crank`: claim only if, the claim having been paid for, this crank can still
        // fund what the queue owes, and at least one request.
        if gas_remaining() < CLAIM_GAS.saturating_add(budget(owed.max(1))) {
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
        let (mut dearest_request, mut handlers) = (0, 0);

        // The batch is allocated once, at the most it can come to: what the frame can afford, CLVR
        // can hold, and the queue can contain. An allocation is never given back, so growing it as
        // it fills would hold every smaller allocation too.
        let affordable = gas_remaining().saturating_sub(EPILOGUE_GAS) / PER_REQUEST;
        let most = affordable.min(u64::from(MAX_BATCH.min(policy.capacity))) as usize;

        // As in a plain crank, a request leaves the queue only once this frame can afford to
        // handle it. A batch taken up front cannot pay as it goes, so each entry taken reserves its
        // whole cost.
        let mut batch = Vec::with_capacity(most);
        let mut reserved = EPILOGUE_GAS;
        while batch.len() < most && gas_remaining() > reserved.saturating_add(PER_REQUEST) {
            let Some(request) = self.requests.try_consume().none_if_missing() else {
                break;
            };
            batch.push(request);
            reserved = reserved.saturating_add(PER_REQUEST);
        }

        let mut clvr = Clvr::new(&batch, read_reserves);
        // In place: an `Option` of a request is no larger than the request.
        let mut batch: Vec<Option<SwapRequest>> = batch.into_iter().map(Some).collect();

        let mut n_failed = 0;
        for _ in 0..batch.len() {
            let request = batch[clvr.choose()]
                .take()
                .expect("CLVR chooses each request once");

            // Read the id before the request is handed over: handling consumes it.
            let id = request.id();
            let gas_limit = request.gas_limit();

            #[cfg(feature = "calibration")]
            let before = gas_remaining();

            let result = handle(request, gas_limit);

            #[cfg(feature = "calibration")]
            {
                let spent = before.saturating_sub(gas_remaining());
                dearest_request = spent.max(dearest_request);
                handlers += spent;
            }

            if let Err(e) = &result {
                // A failure rolls the handler's frame back, so the terminal event for a failed
                // request has to come from here, in the driver's own (committed) frame.
                log_event(&RequestFailed::of(&id, e));
                n_failed += 1;
            }

            clvr.handled(result.is_ok());
        }
        let n_processed = batch.len() as u32;

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

        // What this crank spent, as `Queue::crank` reports it.
        #[cfg(feature = "calibration")]
        {
            let here = gas_remaining();
            log_event(&batch_driver::GasReport {
                processed: n_processed,
                claim: claim_gas,
                dearest_request,
                handlers_total: handlers,
                tail: after_process.saturating_sub(here),
                beyond_handlers: entry_gas
                    .saturating_sub(here)
                    .saturating_sub(handlers)
                    .saturating_sub(claim_gas),
            });
        }

        Ok((n_processed, n_failed))
    }
}
