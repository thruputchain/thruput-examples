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
/// with `r^k` by exponentiation by squaring: a few dozen multiplications however long the gap.
/// `r^k` is kept as a 64-bit mantissa and an exponent, so it keeps its precision however large or
/// small it grows -- over a long quiet stretch it can fall far below what 32 fractional bits hold
/// while still leaving a large fee a substantial remainder. The result is rounded down once, at the
/// end; updating block by block rounds down every block instead, and with a ratio above one those
/// losses compound, so the two agree to within that compounded rounding (a few parts in 10^9 at
/// most).
///
/// Every product fits a `u128`; one too large for it is past the maximum, and taken as it.
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

        let Some(power) = pow(Power::from_fixed(UNIT + delta), blocks) else {
            return ceiling;
        };
        // `whole` is `r^k * 2^64`, so `(whole - 2^64) / delta` is `(r^k - 1) / (r - 1)` units in
        // fixed point.
        let (Some(grown), Some(whole)) = (power.scale(fee), power.scale(1 << 64)) else {
            return ceiling;
        };
        let added = whole.saturating_sub(1 << 64) / delta;
        grown
            .checked_add(added)
            .map_or(ceiling, |fee| fee.min(ceiling))
    } else {
        let delta = ((target - counted) << 32) / (8 * target);
        if delta == 0 {
            return fee.saturating_sub(units);
        }

        // `r < 1`, so `r^k` only shrinks, and both products fit. Once the fee would pass below
        // zero it stays there, so clamping the closed form at zero agrees with clamping block by
        // block.
        let power = pow(Power::from_fixed(UNIT - delta), blocks).unwrap_or(Power::ZERO);
        let shrunk = power.scale(fee).unwrap_or(0);
        let whole = power.scale(1 << 64).unwrap_or(0).min(1 << 64);
        let taken = ((1 << 64) - whole) / delta;
        shrunk.saturating_sub(taken)
    }
}

/// A non-negative number `m * 2^e`, with `m` holding 64 significant bits: what `r^k` is computed
/// in, so that it keeps its precision however large or small it grows.
#[derive(Clone, Copy)]
struct Power {
    m: u128,
    e: i32,
}

impl Power {
    const ONE: Power = Power { m: 1 << 63, e: -63 };
    const ZERO: Power = Power {
        m: 0,
        e: Self::MIN_EXP,
    };

    // Beyond these, `r^k` is out of any fee's reach: above, a fee is at its maximum; below, it is
    // gone.
    const MAX_EXP: i32 = 256;
    const MIN_EXP: i32 = -256;

    // A positive value in 32-bit fixed point.
    fn from_fixed(x: u128) -> Power {
        let shift = 64 - (128 - x.leading_zeros() as i32);
        let m = if shift >= 0 { x << shift } else { x >> -shift };
        Power { m, e: -32 - shift }
    }

    // The product, rounded down to 64 significant bits. Each mantissa is below 2^64, so the
    // product of two fits a `u128`, and for two normalized ones it is at least 2^126.
    fn mul(self, other: Power) -> Power {
        let p = self.m * other.m;
        let s = if p >> 127 == 1 { 64 } else { 63 };
        Power {
            m: p >> s,
            e: self.e + other.e + s,
        }
    }

    // `None` once past any fee's reach above, and zero once past it below.
    fn bounded(self) -> Option<Power> {
        if self.e > Self::MAX_EXP {
            None
        } else if self.e < Self::MIN_EXP {
            Some(Self::ZERO)
        } else {
            Some(self)
        }
    }

    // `x * self`, rounded down, or `None` if it does not fit a `u128`.
    fn scale(self, x: u128) -> Option<u128> {
        const LOW: u128 = (1 << 64) - 1;
        if self.m == 0 || x == 0 {
            return Some(0);
        }
        if self.e >= 0 {
            // At least 2^63 times `x`: past any fee.
            return None;
        }

        // `x * m` is `hi * 2^64 + lo`, with `lo` below 2^64, and is then shifted right by `-e`.
        let hi = (x >> 64) * self.m;
        let lo = (x & LOW) * self.m;
        let hi = hi.checked_add(lo >> 64)?;
        let lo = lo & LOW;

        let shift = self.e.unsigned_abs();
        if shift <= 64 {
            hi.checked_mul(1 << (64 - shift))?.checked_add(lo >> shift)
        } else if shift - 64 < 128 {
            Some(hi >> (shift - 64))
        } else {
            Some(0)
        }
    }
}

/// `base^exp`, or `None` once it is past any fee's reach.
fn pow(mut base: Power, mut exp: u64) -> Option<Power> {
    let mut result = Power::ONE;
    loop {
        if exp & 1 == 1 {
            result = result.mul(base).bounded()?;
        }
        exp >>= 1;
        if exp == 0 {
            return Some(result);
        }
        base = base.mul(base).bounded()?;
    }
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
