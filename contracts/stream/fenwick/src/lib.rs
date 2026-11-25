//! A Fenwick tree in contract storage: sums over every index up to a given one, kept so that
//! updates commute.
//!
//! [`Fenwick`] is a storage type. Embed it in a contract's storage, as a field or a `Node`, and
//! [`add`](Fenwick::add) amounts at `u32` indices. [`prefix_sum`](Fenwick::prefix_sum) answers
//! "how much is there at this index or below?" in at most 32 reads, however many amounts were
//! added, and an add writes at most 32 nodes.
//!
//! ```ignore
//! #[storage]
//! pub struct Schedule {
//!     // What falls due at each second.
//!     due: Fenwick,
//! }
//!
//! fn schedule(&mut self, second: u32, amount: i128) {
//!     self.due.add(second, amount);
//! }
//!
//! fn due_by(&self, second: u32) -> i128 {
//!     self.due.prefix_sum(second)
//! }
//! ```
//!
//! # Why updates commute
//!
//! A Fenwick tree keeps, for each node, the sum of the amounts at a range of indices that ends at
//! that node. An add at an index adds its amount to every node whose range covers the index -- one
//! node per level, at most 32 -- and reads none of them. Each node is a non-negative integer in
//! storage, and an add to one is a pure delta: two transactions' deltas to one node merge, and
//! the runtime commits their total. So any number of adds land in one block, at any indices,
//! without conflicting, and the tree after the block is the same in whatever order they ran.
//! [`subtract`](Fenwick::subtract) is the same, with a negative delta.
//!
//! A prefix sum reads up to 32 nodes, as of the block's start, plus whatever this transaction has
//! added. It never sees another transaction's adds in its own block.
//!
//! # What a subtract may take
//!
//! Every node must stay at or above zero, which the runtime checks when the transaction commits.
//! Subtract only an amount that was added at the same index in an earlier block, and not since
//! subtracted. Then every node it touches holds at least that amount, and none can go negative,
//! whatever else the block does.
//!
//! # Storage
//!
//! A node is created the first time an add touches it, and is never deleted: a node that
//! subtracts bring back to zero still holds a zero. Each node is a data item paid for out of the
//! contract's native tokens, so a contract that lets anyone add should charge for the nodes an add
//! creates: [`missing_nodes`](Fenwick::missing_nodes) counts them.

#![cfg_attr(not(feature = "dev"), no_std)]

use thruput_sdk::storage::*;
use thruput_sdk::*;

/// The most nodes an add writes, or a prefix sum reads: one a level.
pub const LEVELS: u32 = 32;

/// The largest index an amount can be added at.
pub const MAX_INDEX: u32 = u32::MAX - 1;

/// An index past [`MAX_INDEX`].
#[derive(Debug, PartialEq, Eq)]
pub struct OutOfRange;

/// Sums over every index up to a given one. See the [crate docs](crate).
#[derive(Storage)]
pub struct Fenwick {
    // Node `n` holds the sum of the amounts at indices `n - lowbit(n)` to `n - 1`, where
    // `lowbit(n)` is the lowest set bit of `n`. Nodes are numbered from 1, so index `i` is
    // node `i + 1`.
    nodes: Map<u32, NNInt>,
}

impl Fenwick {
    /// Add `amount` at `index`. Writes one node a level, and reads none.
    ///
    /// A negative `amount` is a [`subtract`](Self::subtract).
    pub fn add(&mut self, index: u32, amount: i128) -> Result<(), OutOfRange> {
        for node in updated(index)? {
            self.nodes.at_mut(&node).inc(amount);
        }
        Ok(())
    }

    /// Take `amount` back from `index`: see the [crate docs](crate#what-a-subtract-may-take) for
    /// what may be taken.
    pub fn subtract(&mut self, index: u32, amount: i128) -> Result<(), OutOfRange> {
        self.add(index, -amount)
    }

    /// The sum of every amount at `index` or below: as of the block's start, plus what this
    /// transaction has added.
    pub fn prefix_sum(&self, index: u32) -> i128 {
        // Every index past `MAX_INDEX` holds nothing, so the sum up to it is the sum up to there.
        let mut node = index.min(MAX_INDEX) + 1;
        let mut sum = 0;
        while node > 0 {
            sum += self.node(node);
            // Drop the lowest set bit: on to the range that ends where this one starts.
            node &= node - 1;
        }
        sum
    }

    /// How many nodes an add at `index` would create: the nodes on its path that nobody has
    /// written yet. A contract charges for them.
    ///
    /// It counts what is missing as of the block's start, so two adds in one block that both
    /// find a node missing both count it. Each of them creates it, and holds a deposit for it until
    /// the block closes.
    pub fn missing_nodes(&self, index: u32) -> Result<u32, OutOfRange> {
        let mut missing = 0;
        for node in updated(index)? {
            if self.nodes.at(&node).try_get().none_if_missing().is_none() {
                missing += 1;
            }
        }
        Ok(missing)
    }

    fn node(&self, node: u32) -> i128 {
        self.nodes
            .at(&node)
            .try_get()
            .none_if_missing()
            .unwrap_or(0)
    }
}

/// The nodes an add at `index` writes: the node for `index`, and then each node whose range
/// covers it, up the tree.
fn updated(index: u32) -> Result<impl Iterator<Item = u32>, OutOfRange> {
    if index > MAX_INDEX {
        return Err(OutOfRange);
    }

    // Count in `u64`: the step past the last node overflows a `u32`.
    let first = u64::from(index) + 1;
    Ok(core::iter::successors(Some(first), |&node| {
        // Add the lowest set bit: on to the next range that covers this one.
        let next = node + node.isolate_lowest_one();
        (next <= u64::from(u32::MAX)).then_some(next)
    })
    .map(|node| node as u32))
}
