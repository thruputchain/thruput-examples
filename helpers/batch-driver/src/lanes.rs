//! A queue of several lanes, drained by a crank that chooses between their heads.

use crate::BatchRequest;
use crate::drain::{CLAIM_GAS, EPILOGUE_GAS, budget_for};
use crate::events::{RequestAccepted, RequestFailed};
use crate::queue::{CrankPolicy, InvalidPolicy, Starved, may_claim, settle};
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::storage::*;
use thruput_sdk::*;
use unique_ids::UniqueIds;

/// Chooses, request by request, which lane of a [`LanedQueue`] a crank takes from next.
///
/// A [`Sequencer`](crate::Sequencer) orders a whole batch, which it must therefore see before any
/// of it is handled. A rule that only ever needs to know *what kind* of request comes next -- a
/// buy or a sell, say -- needs much less: if each kind waits in a lane of its own, the rule picks a
/// lane and takes its head. The crank then streams, as a plain [`Queue::crank`] does, holding no
/// batch in memory and deciding how many to take as it goes.
///
/// Within a lane, requests leave in queue order.
///
/// [`Queue::crank`]: crate::Queue::crank
pub trait LanePicker<const N: usize> {
    /// The most gas the picker adds to a request's handling: choosing its lane, finding whether
    /// that lane has more, and learning how it fared, including any calls it makes to do so. The
    /// crank budgets this much on top of [`BatchRequest::GAS_LIMIT`] for each request.
    const GAS_PER_REQUEST: u64;

    /// The lane to take the next request from, of those `waiting` marks as holding one. At least
    /// one does.
    fn next(&mut self, waiting: &[bool; N]) -> usize;

    /// Report how the request just taken fared: `true` if it was handled, `false` if handling it
    /// failed (and so changed nothing).
    fn handled(&mut self, ok: bool);
}

/// [`gas_for_batch`](crate::gas_for_batch), for a [`LanedQueue`] cranked with a picker of type `P`.
pub const fn gas_for_laned_batch<R: BatchRequest, P: LanePicker<N>, const N: usize>(
    batch_size: u32,
) -> u64 {
    let per_request = R::GAS_LIMIT.saturating_add(P::GAS_PER_REQUEST);
    budget_for(per_request, batch_size)
        .saturating_add(CLAIM_GAS)
        .saturating_add(per_request)
}

/// A driver's request queue in `N` lanes, which share one capacity, one source of ids and one
/// crank policy.
///
/// A driver chooses each request's lane when it enqueues it, and a [`LanePicker`] chooses the lane
/// to take from at each step of a crank. Everything else is as for a [`Queue`](crate::Queue): the
/// ceiling, the floor a crank owes, the claim, the isolation of each request's failure, and the
/// events.
///
/// That the lanes share one capacity matters: the ceiling bounds how long an admitted request can
/// wait, and a request in one lane can wait behind requests in another.
#[derive(Storage)]
pub struct LanedQueue<R: BatchRequest, const N: usize> {
    // The entries, one queue per lane, which concurrent transactions insert into.
    lanes: Map<u32, RCQ<R>>,

    // The remaining capacity across all lanes; see `Queue`.
    slots: CapacityConstraint,

    // The source of the id stamped on each accepted entry, whatever its lane.
    ids: Node<UniqueIds>,

    policy: Value<CrankPolicy>,
}

impl<R: BatchRequest, const N: usize> LanedQueue<R, N> {
    /// Set the queue's policy. Call once, when the driver is initialized; see
    /// [`Queue::initialize`](crate::Queue::initialize).
    pub fn initialize(&mut self, policy: CrankPolicy) -> Result<(), InvalidPolicy> {
        if policy.min_batch > policy.capacity {
            return Err(InvalidPolicy);
        }

        self.policy.set(&policy);
        self.slots.set_capacity(i128::from(policy.capacity));

        Ok(())
    }

    /// Accept one entry into `lane`, returning the id stamped on it; see
    /// [`Queue::enqueue`](crate::Queue::enqueue).
    pub fn enqueue(&mut self, lane: usize, stamp: impl FnOnce(SHA256Hash) -> R) -> SHA256Hash {
        assert!(lane < N, "no such lane");

        // As in `Queue::enqueue`: not checked here, so that an enqueue arriving at a full queue
        // fails at commit, with nothing written.
        self.slots.consume_capacity(1);

        let id = self.ids.next_id();
        self.lanes.at_mut(&(lane as u32)).insert(&stamp(id));

        log_event(&RequestAccepted { request_id: &id });

        id
    }

    /// Drain the queue, taking each request from the lane `picker` chooses and handing it to
    /// `handle`; return `(n_processed, n_failed)`.
    ///
    /// The floor, the refusal and the claim are as in [`Queue::crank`](crate::Queue::crank), with
    /// each request costing [`BatchRequest::GAS_LIMIT`] plus [`LanePicker::GAS_PER_REQUEST`]; size
    /// a call with [`gas_for_laned_batch`].
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

        #[cfg(feature = "calibration")]
        let mut picks = crate::drain::PickGas::start();

        // Whether each lane holds a request. A lane found empty stays so for the rest of this
        // transaction -- a crank does not see requests its own block ordered after it -- so only
        // the lane just taken from needs looking at again.
        let mut waiting: [bool; N] = core::array::from_fn(|lane| self.waiting(lane));

        #[cfg(feature = "calibration")]
        picks.setup_done();

        let per_request = R::GAS_LIMIT.saturating_add(P::GAS_PER_REQUEST);
        let any = waiting.contains(&true);
        if !may_claim(&self.policy, &self.slots, any, |n| {
            budget_for(per_request, n)
        })? {
            return Ok((0, 0));
        }

        #[cfg(feature = "calibration")]
        let before_claim = gas_remaining();

        if claim().is_err() {
            return Ok((0, 0));
        }

        #[cfg(feature = "calibration")]
        let claim_gas = before_claim.saturating_sub(gas_remaining());

        #[cfg(feature = "calibration")]
        let mut spent = crate::queue::HandlerGas::default();

        let mut n_processed = 0;
        let mut n_failed = 0;

        // As in a plain crank, the budget is checked before an entry leaves its lane.
        while waiting.contains(&true) && gas_remaining() > per_request.saturating_add(EPILOGUE_GAS)
        {
            #[cfg(feature = "calibration")]
            picks.step();

            let lane = picker.next(&waiting);
            assert!(waiting[lane], "a picker chooses a lane holding a request");

            let request = self
                .lanes
                .at_mut(&(lane as u32))
                .try_consume()
                .none_if_missing()
                .expect("a lane found waiting holds a request");
            waiting[lane] = self.waiting(lane);

            let id = request.id();
            let gas_limit = request.gas_limit();

            #[cfg(feature = "calibration")]
            let before = {
                picks.pause();
                gas_remaining()
            };

            let result = handle(request, gas_limit);

            #[cfg(feature = "calibration")]
            {
                spent.record(before.saturating_sub(gas_remaining()));
                picks.resume();
            }

            if let Err(e) = &result {
                log_event(&RequestFailed::of(&id, e));
                n_failed += 1;
            }
            n_processed += 1;

            picker.handled(result.is_ok());
        }

        #[cfg(feature = "calibration")]
        let after_process = gas_remaining();

        #[cfg(feature = "calibration")]
        picks.report(n_processed);

        settle(&mut self.slots, n_processed, n_failed);

        #[cfg(feature = "calibration")]
        spent.report(n_processed, claim_gas, entry_gas, after_process);

        Ok((n_processed, n_failed))
    }

    // Whether `lane` holds a request.
    fn waiting(&self, lane: usize) -> bool {
        self.lanes
            .at(&(lane as u32))
            .try_peek()
            .none_if_missing()
            .is_some()
    }
}
