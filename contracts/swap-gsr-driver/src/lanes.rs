//! The driver's queue, in lanes: a `batch_driver::Queue` whose one queue is split by the kind of
//! request, drained by a crank that picks which lane to take from next.
//!
//! GSR only ever needs to know *what kind* of trade comes next -- one that lowers the price, or one
//! that raises it -- so if each kind waits in a lane of its own, the rule picks a lane and takes its
//! head. The crank then streams, as a plain `Queue::crank` does, holding no batch in memory and
//! deciding how many to take as it goes.
//!
//! A crank that always took whatever was waiting would let requests that keep arriving overtake
//! one that came before them, crank after crank, for as long as the picker preferred their lane. So
//! each request is stamped with the height of the block that enqueued it, and the requests of one
//! block are a *batch*: the picker chooses only among the lanes whose head belongs to the oldest
//! batch still waiting, and a later block's requests wait until that batch is gone. Batches leave
//! in the order of their blocks, and the picker orders each one. Nothing is stored for this but the
//! stamps: the oldest batch is the least height among the lanes' heads.
//!
//! Everything else is as for a `batch_driver::Queue`, and built from the same parts: the ceiling,
//! the floor a crank owes, the claim, the isolation of each request's failure, and the events.

use batch_driver::{
    BatchRequest, CLAIM_GAS, CrankPolicy, EPILOGUE_GAS, InvalidPolicy, RequestAccepted,
    RequestFailed, RequestsProcessed, Starved,
};
use thruput_sdk::block::get_block_height;
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::storage::*;
use thruput_sdk::*;
use unique_ids::UniqueIds;

/// Chooses, request by request, which lane of a [`LanedQueue`] a crank takes from next, within one
/// batch at a time.
///
/// Within a lane, requests leave in queue order.
pub trait LanePicker<const N: usize> {
    /// The most gas the picker adds to a request's handling: choosing its lane, finding whether
    /// that lane has more, and learning how it fared, including any calls it makes to do so. The
    /// crank budgets this much on top of [`BatchRequest::GAS_LIMIT`] for each request.
    const GAS_PER_REQUEST: u64;

    /// The crank has come to a batch -- the requests one block enqueued -- other than the one the
    /// last request came from, or to its first. What follows, until the next call, is that batch.
    ///
    /// A batch too large for one crank is finished by the next, which begins it again.
    fn begin_batch(&mut self) {}

    /// The lane to take the next request from, of those `waiting` marks as holding one of the
    /// current batch. At least one does.
    fn next(&mut self, waiting: &[bool; N]) -> usize;

    /// Report how the request just taken fared: `true` if it was handled, `false` if handling it
    /// failed (and so changed nothing).
    fn handled(&mut self, ok: bool);
}

/// `batch_driver::gas_for_batch`, for a [`LanedQueue`] cranked with a picker of type `P`.
pub const fn gas_for_laned_batch<R: BatchRequest, P: LanePicker<N>, const N: usize>(
    batch_size: u32,
) -> u64 {
    let per_request = R::GAS_LIMIT.saturating_add(P::GAS_PER_REQUEST);
    budget(per_request, batch_size)
        .saturating_add(CLAIM_GAS)
        .saturating_add(per_request)
}

// The gas a frame must still hold to take `batch_size` more requests costing `per_request` each, as
// in `batch_driver`'s drain.
const fn budget(per_request: u64, batch_size: u32) -> u64 {
    EPILOGUE_GAS.saturating_add((batch_size as u64).saturating_mul(per_request))
}

/// A driver's request queue in `N` lanes, which share one capacity, one source of ids and one
/// crank policy.
///
/// The driver chooses each request's lane when it enqueues it, and a [`LanePicker`] chooses the lane
/// to take from at each step of a crank.
///
/// A request waits behind those enqueued in earlier blocks, whatever their lanes, and behind as
/// many of its own block's as the picker puts first -- and behind nothing enqueued after its block.
/// The lanes share one capacity, so that is at most the ceiling.
#[derive(Storage)]
pub struct LanedQueue<R: BatchRequest, const N: usize> {
    // The entries, one queue per lane, which concurrent transactions insert into.
    lanes: Map<u32, RCQ<Stamped<R>>>,

    // The remaining capacity across all lanes; see `batch_driver::Queue`.
    slots: CapacityConstraint,

    // The source of the id stamped on each accepted entry, whatever its lane.
    ids: Node<UniqueIds>,

    policy: Value<CrankPolicy>,
}

// A request, and the height of the block that enqueued it: its batch.
#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
struct Stamped<T: BatchRequest> {
    height: i64,
    request: T,
}

impl<R: BatchRequest, const N: usize> LanedQueue<R, N> {
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

    /// Accept one entry into `lane`, returning the id stamped on it; see
    /// `batch_driver::Queue::enqueue`.
    pub fn enqueue(&mut self, lane: usize, stamp: impl FnOnce(SHA256Hash) -> R) -> SHA256Hash {
        assert!(lane < N, "no such lane");

        // As in `Queue::enqueue`: not checked here, so that an enqueue arriving at a full queue
        // fails at commit, with nothing written.
        self.slots.consume_capacity(1);

        let id = self.ids.next_id();
        self.lanes.at_mut(&(lane as u32)).insert(&Stamped {
            height: get_block_height().into_inner(),
            request: stamp(id),
        });

        log_event(&RequestAccepted { request_id: &id });

        id
    }

    /// Drain the queue, batch by batch in the order of the blocks that enqueued them, taking each
    /// request from the lane `picker` chooses and handing it to `handle`; return `(n_processed,
    /// n_failed)`.
    ///
    /// The floor, the refusal and the claim are as in `batch_driver::Queue::crank`, with each
    /// request costing [`BatchRequest::GAS_LIMIT`] plus [`LanePicker::GAS_PER_REQUEST`]; size a call
    /// with [`gas_for_laned_batch`].
    pub fn crank<C, P, F>(
        &mut self,
        claim: C,
        mut picker: P,
        mut handle: F,
    ) -> Result<(u32, u32), Starved>
    where
        C: FnOnce() -> Result<(), CallError>,
        P: LanePicker<N>,
        F: FnMut(R, u64) -> Result<(), CallError>,
    {
        #[cfg(feature = "calibration")]
        let entry_gas = gas_remaining();

        // The batch at the head of each lane, if it holds a request. A lane found empty stays so
        // for the rest of this transaction -- a crank does not see requests its own block ordered
        // after it -- so only the lane just taken from needs looking at again.
        let mut heads: [Option<i64>; N] = core::array::from_fn(|lane| self.head(lane));

        let policy = self.policy.get();
        let capacity = i128::from(policy.capacity);
        // How deep the queue was at this block's snapshot. (The remaining capacity can read
        // negative mid-transaction.)
        let queued = (capacity - self.slots.get_remaining_capacity()).clamp(0, capacity) as u32;
        let owed = queued.min(policy.min_batch);

        // Nothing to drain, so nothing to claim.
        if heads.iter().all(Option::is_none) {
            return Ok((0, 0));
        }

        // As in `Queue::crank`: claim only if, the claim having been paid for, this crank can still
        // fund what the queue owes, and at least one request.
        let per_request = R::GAS_LIMIT.saturating_add(P::GAS_PER_REQUEST);
        if gas_remaining() < CLAIM_GAS.saturating_add(budget(per_request, owed.max(1))) {
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

        let mut n_processed = 0;
        let mut n_failed = 0;

        // The batch the last request came from.
        let mut batch = None;

        // The oldest batch waiting is the least height at the head of a lane: within a lane,
        // heights only rise.
        while let Some(oldest) = heads.iter().flatten().min().copied() {
            // As in a plain crank, the budget is checked before an entry leaves its lane.
            if gas_remaining() <= per_request.saturating_add(EPILOGUE_GAS) {
                break;
            }

            if batch != Some(oldest) {
                batch = Some(oldest);
                picker.begin_batch();
            }

            // Only that batch's requests are on offer; a later block's wait for it to go.
            let waiting: [bool; N] = core::array::from_fn(|lane| heads[lane] == Some(oldest));
            let lane = picker.next(&waiting);
            assert!(
                waiting[lane],
                "a picker chooses a lane holding a request of the batch"
            );

            let request = self
                .lanes
                .at_mut(&(lane as u32))
                .try_consume()
                .none_if_missing()
                .expect("a lane found waiting holds a request")
                .request;
            heads[lane] = self.head(lane);

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
            n_processed += 1;

            picker.handled(result.is_ok());
        }

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

    // The batch of the request at the head of `lane`, if it holds one.
    fn head(&self, lane: usize) -> Option<i64> {
        self.lanes
            .at(&(lane as u32))
            .try_peek()
            .none_if_missing()
            .map(|head| head.height)
    }
}
