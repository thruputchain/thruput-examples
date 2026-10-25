//! An EIP-1559-style fee steered by a load the contract measures: a queue's backlog, say.
//!
//! [`FeeMarket`] is a storage type. Embed it in a contract's own storage, as a field or a `Node`,
//! [`initialize`](FeeMarket::initialize) it with a target load and a maximum fee, and call
//! [`update`](FeeMarket::update) with the current load wherever the contract charges the fee: it
//! returns the fee in force, in whole units. In each block whose load is above the target, the fee
//! rises by up to an eighth, plus a unit; in each whose load is below it, the fee falls by up to an
//! eighth, less a unit -- as EIP-1559's base fee does against its gas target. A new market's fee is
//! zero, and the fee never exceeds the market's maximum. What the load is, and collecting the fee,
//! are the contract's business.
//!
//! ```ignore
//! #[storage]
//! pub struct Waitlist {
//!     waiting: Balance,
//!     fee: Node<FeeMarket>,
//! }
//!
//! fn join(&mut self) {
//!     // The backlog as of this block's start: read before this join adds to it.
//!     let fee = self.fee.update(self.waiting.get());
//!     // ... take `fee` from the caller ...
//!     self.waiting.increase(1);
//! }
//! ```
//!
//! # The load
//!
//! The load passed in a block must be the same for every transaction in it: the value as of the
//! block's start, read before the transaction changes it. A queue's depth read before the caller's
//! own entry is such a value. That is what keeps callers from conflicting over the fee: they all
//! compute the same fee and record the same state, and identical writes to one key do not
//! conflict. Two transactions that pass different loads in one block write different states, and
//! cannot both land.
//!
//! The fee for a block is computed from the load at that block's start, and when blocks pass
//! without an update, every one of them is taken to have had the load passed now. That is exact if
//! the contract updates in every block that changes the load -- every block that adds to a queue
//! *and* every block that drains it -- since the load then cannot have changed in the blocks
//! between. Updating only where the fee is charged is an approximation, which takes the latest load
//! as the load across the whole gap. Either way, the gap is computed in closed form (see
//! [`adjust`]), so it costs the same however long it is.
//!
//! # The maximum
//!
//! A load that stays above the target raises the fee in every block, whether or not anyone is
//! paying it: a backlog nobody drains compounds the fee by an eighth a block. The maximum is what
//! bounds that. A contract whose load can be held up -- a queue someone fills and nobody serves --
//! should pick a maximum it can live with, and give someone a way to bring the load back down.

#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::storage::*;
use thruput_sdk::*;

/// One unit of fee, in the fixed point the fee is kept in.
///
/// The fee is charged in whole units, but kept with 32 fractional bits, so that the fractions a
/// block's adjustment produces are not lost before the next block's.
const UNIT: u128 = 1 << 32;

/// The fee as of the last block it was updated in, and the target and maximum it is kept to.
///
/// One value, so an update reads all of it in one storage load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ReadXDR, WriteXDR)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
pub struct FeeState {
    /// The load the fee steers toward.
    pub target: u32,

    /// The most the fee can reach, in whole units.
    pub max_fee: u64,

    /// The fee in force in block `height`, in 32-bit fixed point: `fee >> 32` whole units.
    pub fee: u128,

    /// The block this state is for.
    pub height: i64,
}

impl FeeState {
    /// The state of a new market: free.
    pub fn new(target: u32, max_fee: u64, height: i64) -> Self {
        Self {
            target,
            max_fee,
            fee: 0,
            height,
        }
    }

    /// The state for block `height`, whose load at its start is `load`.
    ///
    /// Unchanged if this state is already for `height` (or later): within a block, the fee holds.
    /// Otherwise each block since is taken to have had `load`, which it did if the load has been
    /// updated in every block that changed it.
    pub fn at(&self, height: i64, load: u128) -> Self {
        let blocks = height.saturating_sub(self.height);
        if blocks <= 0 {
            return *self;
        }

        Self {
            fee: adjust(self.fee, self.target, load, blocks as u64, self.max_fee),
            height,
            ..*self
        }
    }

    /// The fee in force, in whole units.
    pub fn charge(&self) -> u64 {
        (self.fee >> 32) as u64
    }
}

/// Bring `fee` (in 32-bit fixed point) forward over `blocks` blocks, each with load `load`, against
/// a target of `target`, never letting it exceed `max_fee` whole units.
///
/// Each block multiplies the fee by `r = 1 + (load - target) / (8 * target)`, with the load capped
/// at twice the target -- so by an eighth at most, as in EIP-1559 -- and then adds a unit if the
/// load is above the target, or takes one away if it is below. The unit is how a free market
/// starts to charge, and how a fee gets all the way back to zero.
///
/// That step is affine, so any number of blocks is computed at once, in closed form:
///
/// ```text
/// fee_k = fee * r^k  ±  (r^k - 1) / (r - 1)   units
/// ```
///
/// with `r^k` by exponentiation by squaring: a few dozen multiplications however long the gap, and
/// the same result, up to rounding, as updating block by block. Everything fits in a `u128`; a
/// product too large for one is past the maximum, and is taken as the maximum.
pub fn adjust(fee: u128, target: u32, load: u128, blocks: u64, max_fee: u64) -> u128 {
    let ceiling = u128::from(max_fee) << 32;
    let fee = fee.min(ceiling);
    if blocks == 0 || target == 0 {
        return fee;
    }

    let target = u128::from(target);
    let counted = load.min(2 * target);
    if counted == target {
        return fee;
    }
    let units = u128::from(blocks).saturating_mul(UNIT);

    if counted > target {
        // `r - 1`, in fixed point: up to an eighth. Against a large target, a load just above it
        // rounds this to zero, leaving only the unit a block.
        let delta = ((counted - target) << 32) / (8 * target);
        if delta == 0 {
            return fee.saturating_add(units).min(ceiling);
        }

        // The added term alone reaches the ceiling once `r^k` reaches `1 + max_fee * (r - 1)`, so
        // `r^k` need not be known past that. (At most 2^93: `max_fee` < 2^64, `delta` <= 2^29.)
        let bound = UNIT + u128::from(max_fee) * delta;
        let Some(power) = pow(UNIT + delta, blocks, bound) else {
            return ceiling;
        };
        let Some(grown) = fee.checked_mul(power) else {
            return ceiling;
        };
        let added = ((power - UNIT) << 32) / delta;
        ((grown >> 32) + added).min(ceiling)
    } else {
        let delta = ((target - counted) << 32) / (8 * target);
        if delta == 0 {
            return fee.saturating_sub(units);
        }

        // `r < 1`, so `r^k` only shrinks, and nothing here can overflow: `fee` < 2^96 and
        // `power` <= 2^32. Once the fee would pass below zero it stays there, so clamping the
        // closed form at zero agrees with clamping block by block.
        let power = pow(UNIT - delta, blocks, u128::MAX).unwrap_or(0);
        let shrunk = (fee * power) >> 32;
        let taken = ((UNIT - power) << 32) / delta;
        shrunk.saturating_sub(taken)
    }
}

/// `base^exp`, both in 32-bit fixed point, or `None` once it would reach `bound`.
///
/// For a `base` of at least one, the powers only grow, so the first square or product to reach
/// `bound` means the result would too; a product that overflows a `u128` is past any bound here.
fn pow(mut base: u128, mut exp: u64, bound: u128) -> Option<u128> {
    let mut result = UNIT;
    loop {
        if exp & 1 == 1 {
            result = mul(result, base).filter(|&r| r < bound)?;
        }
        exp >>= 1;
        if exp == 0 {
            return Some(result);
        }
        base = mul(base, base).filter(|&b| b < bound)?;
    }
}

// The product of two fixed-point values, or `None` if it does not fit.
fn mul(a: u128, b: u128) -> Option<u128> {
    a.checked_mul(b).map(|p| p >> 32)
}

/// A fee that steers a load toward a target. See the [crate docs](crate).
#[derive(Storage)]
pub struct FeeMarket {
    // The fee as of the last block it was updated in. Every update in a block writes the same value
    // here, so updates do not conflict over it.
    state: Value<FeeState>,
}

/// Why [`FeeMarket::initialize`] refused.
#[derive(Debug, PartialEq, Eq)]
pub enum InitError {
    /// A target of zero, which no fee could steer toward.
    ZeroTarget,

    /// A maximum fee of zero, which would leave the market always free.
    ZeroMaxFee,

    /// The market is already running. Starting it again would reset its fee to zero, which
    /// would let anyone who could call it make the contract free to use.
    AlreadyInitialized,
}

impl FeeMarket {
    /// Start the market, free, steering toward a load of `target`, with a fee of at most `max_fee`
    /// units. Refuses a second call.
    pub fn initialize(&mut self, target: u32, max_fee: u64) -> Result<(), InitError> {
        if target == 0 {
            return Err(InitError::ZeroTarget);
        }
        if max_fee == 0 {
            return Err(InitError::ZeroMaxFee);
        }
        if self.state.try_get().none_if_missing().is_some() {
            return Err(InitError::AlreadyInitialized);
        }

        self.state.set(&FeeState::new(
            target,
            max_fee,
            get_block_height().into_inner(),
        ));

        Ok(())
    }

    /// The fee in force in this block, given the load at its start, without recording it.
    pub fn quote(&self, load: u128) -> u64 {
        self.current(load).charge()
    }

    /// The fee in force in this block, given the load at its start, recording it for later blocks
    /// to be computed from.
    ///
    /// Call it wherever the contract charges the fee, and, for an exact fee, in every block that
    /// changes the load. Once this transaction has recorded the state, a later call here finds it
    /// current and records it unchanged.
    pub fn update(&mut self, load: u128) -> u64 {
        let state = self.current(load);
        self.state.set(&state);
        state.charge()
    }

    // The state for the current block.
    fn current(&self, load: u128) -> FeeState {
        self.state.get().at(get_block_height().into_inner(), load)
    }
}
