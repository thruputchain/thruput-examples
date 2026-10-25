//! An EIP-1559-style fee steered by a load the contract measures: a queue's backlog, say.
//!
//! [`FeeMarket`] is a storage type. Embed it in a contract's own storage, as a field or a `Node`,
//! [`initialize`](FeeMarket::initialize) it with a target load and a maximum fee, and call
//! [`update`](FeeMarket::update) with the current load wherever the contract charges the fee: it
//! returns the fee in force. In each block whose load is above the target, the fee rises by up to
//! an eighth; in each whose load is below it, the fee falls by up to an eighth -- as EIP-1559's
//! base fee does against its gas target. A new market's fee is zero, and the fee never exceeds the
//! market's maximum. What the load is, and collecting the fee, are the contract's business.
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
//! as the load across the whole gap.
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

/// The most any market's fee can reach, whatever its own maximum. It leaves room for the
/// fixed-point multiply in [`adjust`].
pub const MAX_FEE: u128 = 1 << 95;

/// The most blocks of adjustment a single computation applies.
///
/// A longer gap is adjusted as this many blocks. That is enough for a fee to fall from
/// [`MAX_FEE`] to zero, or to climb from zero to any maximum.
pub const MAX_STEPS: u64 = 512;

/// The fee as of the last block it was updated in, and the target and maximum it is kept to.
///
/// One value, so an update reads all of it in one storage load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ReadXDR, WriteXDR)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
pub struct FeeState {
    /// The load the fee steers toward.
    pub target: u32,

    /// The most the fee can reach.
    pub max_fee: u128,

    /// The fee in force in block `height`.
    pub fee: u128,

    /// The block this state is for.
    pub height: i64,
}

impl FeeState {
    /// The state of a new market: free.
    pub fn new(target: u32, max_fee: u128, height: i64) -> Self {
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
}

/// Bring `fee` forward over `blocks` blocks, each with load `load`, against a target of `target`,
/// never letting it exceed `max_fee` (nor [`MAX_FEE`]).
///
/// Each block moves the fee by `(load - target) / (8 * target)`, with the load capped at twice the
/// target -- so by an eighth at most, as in EIP-1559. A block above target raises the fee by at
/// least one unit, which is how it rises from zero; a block below target lowers it by at least one
/// unit, which is how it gets back there.
pub fn adjust(fee: u128, target: u32, load: u128, blocks: u64, max_fee: u128) -> u128 {
    let ceiling = max_fee.min(MAX_FEE);
    if blocks == 0 || target == 0 {
        return fee.min(ceiling);
    }

    let target = i128::from(target);
    let counted = i128::try_from(load).unwrap_or(i128::MAX).min(2 * target);

    // The per-block ratio, in 32-bit fixed point: within an eighth of one either way.
    let delta = ((counted - target) << 32) / (8 * target);
    if delta == 0 {
        return fee.min(ceiling);
    }
    let ratio = ((1i128 << 32) + delta) as u128;

    let mut fee = fee.min(ceiling);
    for _ in 0..blocks.min(MAX_STEPS) {
        let scaled = (fee * ratio) >> 32;
        fee = if delta > 0 {
            scaled.max(fee + 1).min(ceiling)
        } else {
            scaled
        };

        if fee == 0 || fee == ceiling {
            break;
        }
    }

    fee
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
    /// Start the market, free, steering toward a load of `target`, with a fee of at most `max_fee`.
    /// Refuses a second call.
    pub fn initialize(&mut self, target: u32, max_fee: u128) -> Result<(), InitError> {
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
    pub fn quote(&self, load: u128) -> u128 {
        self.current(load).fee
    }

    /// The fee in force in this block, given the load at its start, recording it for later blocks
    /// to be computed from.
    ///
    /// Call it wherever the contract charges the fee, and, for an exact fee, in every block that
    /// changes the load. Once this transaction has recorded the state, a later call here finds it
    /// current and records it unchanged.
    pub fn update(&mut self, load: u128) -> u128 {
        let state = self.current(load);
        self.state.set(&state);
        state.fee
    }

    // The state for the current block.
    fn current(&self, load: u128) -> FeeState {
        self.state.get().at(get_block_height().into_inner(), load)
    }
}
