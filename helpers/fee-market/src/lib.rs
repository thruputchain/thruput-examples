//! An EIP-1559-style fee for entering something: a queue, a sale, any contract operation whose
//! throughput a contract wants to price.
//!
//! [`FeeMarket`] is a storage type. Embed it in a contract's own storage, as a field or a `Node`,
//! [`initialize`](FeeMarket::initialize) it with a target number of entries per block, and call
//! [`enter`](FeeMarket::enter) on each entry: it returns what that entry owes. While blocks receive
//! more entries than the target, the fee rises by up to an eighth per block; while they receive
//! fewer, it falls by up to an eighth -- as EIP-1559's base fee does against its gas target. An
//! unused market's fee is zero. Collecting the fee is the contract's business.
//!
//! ```ignore
//! #[storage]
//! pub struct Sale {
//!     fee: Node<FeeMarket>,
//! }
//!
//! fn buy(&mut self) {
//!     let fee = self.fee.enter();
//!     // ... take `fee` from the caller ...
//! }
//! ```
//!
//! # Concurrency
//!
//! Entries never conflict with one another over the fee, however many land in one block. The fee
//! in force in a block is a function of the state at the start of that block -- the fee as last
//! recorded, how many blocks ago, and how many entries since -- which every transaction in it reads
//! alike. So every entry in the block computes the same fee, and records the same updated state:
//! their writes are identical, and identical writes to one key do not conflict. The entries
//! themselves are counted with a blind increment, which commutes.
//!
//! When blocks pass with no entry, the next one brings the fee forward over all of them, and it can
//! do so exactly: a block with any entry recorded the state for itself, so everything counted since
//! the state was recorded arrived in that block, and the blocks after it were empty.
//!
//! # Cost
//!
//! An entry loads two keys the first time a transaction touches them -- the state and the count --
//! and writes the state. The arithmetic is a handful of multiplications per block brought forward.

#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::storage::*;
use thruput_sdk::*;

/// The most the fee can reach. It leaves room for the fixed-point multiply in [`adjust`].
pub const MAX_FEE: u128 = 1 << 95;

/// The most blocks of adjustment a single computation applies.
///
/// A longer gap is adjusted as this many blocks. Only a long idle stretch is that long, and over
/// it the fee falls by an eighth per block -- to zero, from any fee below [`MAX_FEE`].
pub const MAX_STEPS: u64 = 512;

/// The fee as of the last block anything entered, and what is needed to bring it up to date.
///
/// One value, so an entry reads all of it in one storage load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ReadXDR, WriteXDR)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
pub struct FeeState {
    /// The entries per block the fee steers toward.
    pub target: u32,

    /// The fee in force in block `height`.
    pub fee: u128,

    /// The block this state is for.
    pub height: i64,

    /// How many entries there had been by the start of block `height`.
    pub count: i128,
}

impl FeeState {
    /// The state of a new market: free to enter, with no entries yet.
    pub fn new(target: u32, height: i64, count: i128) -> Self {
        Self {
            target,
            fee: 0,
            height,
            count,
        }
    }

    /// The state for block `height`, given how many entries there had been by its start.
    ///
    /// Unchanged if this state is already for `height` (or later): within a block, the fee holds.
    pub fn at(&self, height: i64, count: i128) -> Self {
        let blocks = height.saturating_sub(self.height);
        if blocks <= 0 {
            return *self;
        }

        // Everything counted since arrived in block `self.height` itself, and the blocks after it
        // were empty: a block with an arrival would have recorded a later state.
        let arrivals = count.saturating_sub(self.count).max(0) as u128;
        let fee = adjust(self.fee, self.target, arrivals, 1);
        Self {
            fee: adjust(fee, self.target, 0, blocks as u64 - 1),
            height,
            count,
            ..*self
        }
    }
}

/// Bring `fee` forward over `blocks` blocks in each of which `arrivals` requests arrived, against a
/// target of `target` per block.
///
/// Each block moves the fee by `(arrived - target) / (8 * target)`, with what arrived capped at
/// twice the target -- so by an eighth at most, as in EIP-1559. A block above target raises the fee
/// by at least one unit, which is how it rises from zero; a block below target lowers it by at
/// least one unit, which is how it gets back there.
pub fn adjust(fee: u128, target: u32, arrivals: u128, blocks: u64) -> u128 {
    if blocks == 0 || target == 0 {
        return fee;
    }

    let target = i128::from(target);
    let counted = i128::try_from(arrivals)
        .unwrap_or(i128::MAX)
        .min(2 * target);

    // The per-block ratio, in 32-bit fixed point: within an eighth of one either way.
    let delta = ((counted - target) << 32) / (8 * target);
    if delta == 0 {
        return fee;
    }
    let ratio = ((1i128 << 32) + delta) as u128;

    let mut fee = fee.min(MAX_FEE);
    for _ in 0..blocks.min(MAX_STEPS) {
        let scaled = (fee * ratio) >> 32;
        fee = if delta > 0 {
            scaled.max(fee + 1).min(MAX_FEE)
        } else {
            scaled
        };

        if fee == 0 || fee == MAX_FEE {
            break;
        }
    }

    fee
}

/// An entry fee that steers entries per block toward a target. See the [crate docs](crate).
#[derive(Storage)]
pub struct FeeMarket {
    // The fee as of the last block anything entered. Every entry in a block writes the same value
    // here, so entries do not conflict over it.
    state: Value<FeeState>,

    // How many entries there have ever been. Only ever incremented blindly, which commutes.
    entries: NNInt,
}

/// Why [`FeeMarket::initialize`] refused.
#[derive(Debug, PartialEq, Eq)]
pub enum InitError {
    /// A target of zero entries per block, which no fee could steer toward.
    ZeroTarget,

    /// The market is already running. Starting it again would reset its fee to zero, which
    /// would let anyone who could call it make entry free.
    AlreadyInitialized,
}

impl FeeMarket {
    /// Start the market, free to enter, steering toward `target` entries per block. Refuses a
    /// second call.
    pub fn initialize(&mut self, target: u32) -> Result<(), InitError> {
        if target == 0 {
            return Err(InitError::ZeroTarget);
        }
        if self.state.try_get().none_if_missing().is_some() {
            return Err(InitError::AlreadyInitialized);
        }

        self.state.set(&FeeState::new(
            target,
            get_block_height().into_inner(),
            self.count(),
        ));

        Ok(())
    }

    /// What an entry costs in this block. Every transaction in a block sees the same figure.
    pub fn quote(&self) -> u128 {
        self.current().fee
    }

    /// Make one entry, returning what it owes.
    ///
    /// Brings the recorded fee up to date for this block, and counts the entry toward the next.
    pub fn enter(&mut self) -> u128 {
        // Read before counting this entry, which belongs to this block's arrivals, not to the
        // state at its start. Once this transaction has recorded the state, a second entry here
        // finds it current and records it unchanged.
        let state = self.current();
        self.state.set(&state);
        self.entries.inc(1);

        state.fee
    }

    // The state for the current block.
    fn current(&self) -> FeeState {
        self.state
            .get()
            .at(get_block_height().into_inner(), self.count())
    }

    // How many entries there have been: all of them as of the start of this block, plus this
    // transaction's own.
    fn count(&self) -> i128 {
        self.entries.try_get().none_if_missing().unwrap_or(0)
    }
}
