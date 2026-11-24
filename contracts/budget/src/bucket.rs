//! A token bucket whose contents are a [`CapacityConstraint`]: the runtime, not the contract,
//! checks that the spends in a block fit what the bucket holds.

use thruput_sdk::storage::{CapacityConstraint, Value};
use thruput_sdk::*;

const NANOS_PER_SECOND: u128 = 1_000_000_000;

/// How much a bucket holds when full, and how fast it refills.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limit {
    /// What the bucket holds when full: the most that can be spent at once, after a quiet spell.
    pub burst: i128,

    /// How much flows back in over each `period`, until the bucket is full again.
    pub refill: i128,

    /// The refill period, in seconds.
    pub period: u64,
}

impl Limit {
    /// A burst of zero is a bucket that stays empty, and a refill of zero one that never refills:
    /// both are limits. A period must be at least a second.
    pub fn is_valid(&self) -> bool {
        self.burst >= 0 && self.refill >= 0 && self.period > 0
    }
}

/// The whole units that have flowed in under `limit` from the Unix epoch to `t`, in nanoseconds.
///
/// Units arrive at fixed moments, `period / refill` apart. A refill credits the ones whose moments
/// it has passed since the last, so no fraction of a unit is ever lost or credited twice: refills
/// however often add up to what one refill over the whole stretch would.
fn flowed(limit: &Limit, t: u64) -> U256 {
    // At most `2^127 * 2^64 / 10^9`: the quotient always fits.
    U256::mul_div(
        U256::from(limit.refill as u128),
        U256::from(u128::from(t)),
        U256::from(u128::from(limit.period) * NANOS_PER_SECOND),
    )
}

/// What a bucket under `limit` holds at `now`, if it held `held` with its refills counted up to
/// `counted_to` (both in Unix nanoseconds). Its refills are then counted up to `now`. `None` if
/// the bucket has room and no whole unit has flowed in since: there is nothing to record.
///
/// A full bucket gains nothing from time passing.
pub fn refill(limit: &Limit, held: i128, counted_to: u64, now: u64) -> Option<i128> {
    if now <= counted_to {
        return None;
    }
    let credit = flowed(limit, now) - flowed(limit, counted_to);
    let room = limit.burst.saturating_sub(held);
    if room <= 0 || credit >= U256::from(room as u128) {
        return Some(limit.burst);
    }
    if credit.is_zero() {
        return None;
    }
    // Less than the room, so it fits.
    Some(held + u128::try_from(credit).unwrap_or_default() as i128)
}

fn now() -> u64 {
    get_block_timepoint().into_inner()
}

/// A bucket: what it holds, and how far its refills have been counted. Its [`Limit`] is kept by
/// whoever owns the bucket, and passed in.
///
/// Every spend in a block starts from the bucket as of the block's start, and refills it the same
/// way, so they all record the same count and set the same capacity. Identical writes to a key do
/// not conflict. What each spend takes is a `consume_capacity`, a delta, which merges with the
/// others. The runtime admits a block's spends while their sum fits what the bucket held, and
/// turns away the rest with `BoundsExceeded`.
#[derive(Storage)]
pub struct Bucket {
    counted_to: Value<u64>,
    held: CapacityConstraint,
}

impl Bucket {
    /// Fill the bucket to `burst`, and count its refills from now.
    pub fn fill(&mut self, burst: i128) {
        self.counted_to.set(&now());
        self.held.set_capacity(burst);
        self.held.flush();
    }

    /// What the bucket holds in this block: as of the block's start, refilled, less whatever this
    /// transaction has taken.
    pub fn available(&self, limit: &Limit) -> i128 {
        let held = self.held.get_remaining_capacity();
        refill(limit, held, self.counted_to.get(), now()).unwrap_or(held)
    }

    /// Take `amount`, if the bucket holds that much in this block. Returns whether it did.
    ///
    /// That is checked against the bucket as of the block's start, which every spend in the block
    /// sees alike. The check here gives a spend that could never fit a clear error; whether the
    /// spends in a block fit together is the runtime's check, when the block is built.
    pub fn take(&mut self, limit: &Limit, amount: i128) -> bool {
        let now = now();
        let mut held = self.held.get_remaining_capacity();
        if let Some(refilled) = refill(limit, held, self.counted_to.get(), now) {
            // The first refill in a transaction is its first write to the capacity, as
            // `set_capacity` requires. A second take in the same transaction refills nothing: it
            // finds the count at the block's time, or no new unit since.
            self.held.set_capacity(refilled);
            self.counted_to.set(&now);
            held = refilled;
        }
        if held < amount {
            return false;
        }
        self.held.consume_capacity(amount);
        self.held.flush();
        true
    }

    /// Delete the bucket, returning the storage deposits for it.
    pub fn delete(&mut self) {
        use thruput_sdk::storage::deletable::Deletable;
        self.counted_to.delete();
        self.held.delete();
    }
}
