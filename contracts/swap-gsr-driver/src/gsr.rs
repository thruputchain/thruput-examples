//! The Greedy Sequencing Rule, applied to one crank's batch.
//!
//! GSR (Ferreira and Parkes, [*Credible Decentralized Exchange Design via Verifiable Sequencing
//! Rules*][paper]) orders a batch of trades against one pool by looking only at which side of the
//! starting price p₀ the pool's price is on: while it is at or above p₀, take a trade that lowers
//! it; while it is below, take one that raises it; once one kind runs out, take the rest. The
//! paper's guarantee is that every trade either gets a price at least as good as it would have
//! alone at p₀, or gets a worse one from which whoever ordered it gains nothing -- so a sandwich
//! does not pay.
//!
//! The rule never needs to compare two trades of the same kind, so it needs no sorting: each kind
//! keeps its queue order, and each step takes the next of one kind.
//!
//! With the price p = reserve1 / reserve0, a trade paying token0 in lowers it, and one paying token1
//! in raises it. Adding and removing liquidity leave it where it is, so they go first, in queue
//! order. A malformed swap (a zero amount, or a token index other than 0 or 1) goes with them, to
//! fail. At p₀ exactly this takes a trade that lowers the price; either fixed choice keeps the
//! rule's guarantee.
//!
//! CLVR (`swap-clvr-driver`) refines this: rather than the next trade on the right side, it takes
//! the one that leaves the price nearest p₀, which keeps the price closer to p₀ through the batch --
//! at the cost of sorting the batch, and searching it at each step.
//!
//! [paper]: https://arxiv.org/abs/2209.15569

use alloc::vec::Vec;
use core::cmp::Ordering;
use swap_if::{Amounts, SwapOp, SwapRequest, U256};

/// Requests that do not move the price: liquidity operations, and malformed swaps.
const UNPRICED: usize = 0;

/// Trades paying token0 in, which lower the price.
const LOWERS: usize = 1;

/// Trades paying token1 in, which raise the price.
const RAISES: usize = 2;

/// What a GSR crank may spend per request beyond handling it: taking it out of the queue and
/// decoding it, choosing it, and reading the pool's reserves before the next.
///
/// Calibrated on a devnode by `scripts/swap-gas-calibrate.sh` (what a crank spent beyond its
/// handler calls, less what `swap-driver`'s did), and held at about twice the most it came to: some
/// 127k a request for a batch of one, almost all of it the first read of the pool's state, which
/// touches the LP token cold; 71k for two, 37k for five.
pub const PICK_GAS: u64 = 260_000;

/// The most requests a GSR crank orders at once: what fits in the driver's memory, which holds the
/// whole batch.
///
/// A guest has 64 KiB of memory unless its artifact declares more, and its allocator never frees.
/// On the RV32 executor (`tests/pool.rs`'s `the_largest_batch_fits`, under `guest_test`) a crank of
/// 148 trades fitted and one of 152 faulted; this keeps some 15% in hand, as CLVR's does. It also
/// keeps a crank of swaps, at five events each, well inside the 1000 a transaction may emit.
pub const MAX_BATCH: u32 = 128;

/// Which kind of request `op` is, for the rule.
fn kind_of(op: &SwapOp) -> usize {
    let (in_index, amount) = match op {
        SwapOp::SwapExactIn(req) => (req.in_index, req.amount_in),
        SwapOp::SwapExactOut(req) => (req.in_index, req.amount_out),
        SwapOp::AddLiquidity(_) | SwapOp::RemoveLiquidity(_) => return UNPRICED,
    };

    match (in_index, amount) {
        (_, 0) => UNPRICED,
        (0, _) => LOWERS,
        (1, _) => RAISES,
        _ => UNPRICED,
    }
}

/// A GSR ordering of one batch, handing the batch's requests out one at a time as a
/// [`batch_driver::Sequencer`].
///
/// It reads the pool's reserves from `read_reserves` when it needs them: before the first trade,
/// and after any request that succeeded. A rule that only asks which side of p₀ the price is on can
/// afford to ask the pool itself, so there is no model of the reserves to go wrong.
pub struct Gsr<F = fn() -> Amounts> {
    // The batch indices of each kind of request, in queue order. (Reversed, so the next is last.)
    kinds: [Vec<usize>; 3],

    read_reserves: F,

    // The reserves at which p₀ was taken: the pool's, when the first trade was placed.
    start: Option<Amounts>,

    // The pool's reserves now, if known.
    reserves: Option<Amounts>,
}

impl<F: FnMut() -> Amounts> Gsr<F> {
    /// Prepare to order `batch`, against the reserves that `read_reserves` reports when asked.
    pub fn new(batch: &[SwapRequest], read_reserves: F) -> Self {
        // Each list is allocated once at the length it will have, since memory is never given back.
        let mut lengths = [0; 3];
        for request in batch {
            lengths[kind_of(&request.op)] += 1;
        }
        let mut kinds = lengths.map(Vec::with_capacity);
        for (k, request) in batch.iter().enumerate().rev() {
            kinds[kind_of(&request.op)].push(k);
        }

        Gsr {
            kinds,
            read_reserves,
            start: None,
            reserves: None,
        }
    }

    // The kind of request to take next.
    fn next_kind(&mut self) -> usize {
        if !self.kinds[UNPRICED].is_empty() {
            return UNPRICED;
        }

        let r = *self.reserves.get_or_insert_with(&mut self.read_reserves);
        let p0 = *self.start.get_or_insert(r);

        let toward = if side(r, p0) == Ordering::Less {
            RAISES
        } else {
            LOWERS
        };

        if self.kinds[toward].is_empty() {
            LOWERS + RAISES - toward
        } else {
            toward
        }
    }
}

impl<F: FnMut() -> Amounts> batch_driver::Sequencer for Gsr<F> {
    const GAS_PER_REQUEST: u64 = PICK_GAS;
    const MAX_BATCH: u32 = MAX_BATCH;

    fn next(&mut self) -> usize {
        let kind = self.next_kind();
        self.kinds[kind].pop().expect("a request is left to place")
    }

    fn handled(&mut self, ok: bool) {
        // A request that failed changed nothing; one that succeeded may have moved the price.
        if ok {
            self.reserves = None;
        }
    }
}

// Where the reserves `r` put the price, relative to p₀ (the price of `p0`). An empty pool has no
// price, and counts as at p₀.
fn side(r: Amounts, p0: Amounts) -> Ordering {
    // p / p₀ = (r1 / r0) / (p0_1 / p0_0) = (r1 * p0_0) / (r0 * p0_1)
    U256::widening_mul(r[1], p0[0]).cmp(&U256::widening_mul(r[0], p0[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use batch_driver::Sequencer;
    use core::cell::Cell;
    use thruput_sdk::ContractAddress;

    const TRADER: ContractAddress = ContractAddress::new([1; 32]);

    fn lower(amount_in: u128) -> SwapRequest {
        SwapRequest::swap_exact_in(&TRADER, amount_in, 0, 0, &TRADER)
    }

    fn raise(amount_in: u128) -> SwapRequest {
        SwapRequest::swap_exact_in(&TRADER, amount_in, 0, 1, &TRADER)
    }

    fn add_liquidity() -> SwapRequest {
        SwapRequest::add_liquidity(&TRADER, [1, 1], [0, 0], &TRADER)
    }

    // Run GSR over `batch` against a constant-product pool without fees starting at `reserves`, in
    // which every trade succeeds; return the order.
    fn order(reserves: Amounts, batch: &[SwapRequest]) -> Vec<usize> {
        let pool = Cell::new(reserves);
        let mut gsr = Gsr::new(batch, || pool.get());

        let mut taken = Vec::new();
        for _ in 0..batch.len() {
            let k = gsr.next();
            taken.push(k);

            let [r0, r1] = pool.get();
            if let SwapOp::SwapExactIn(req) = &batch[k].op {
                let a = req.amount_in;
                match kind_of(&batch[k].op) {
                    LOWERS => pool.set([r0 + a, r0 * r1 / (r0 + a)]),
                    RAISES => pool.set([r0 * r1 / (r1 + a), r1 + a]),
                    _ => {}
                }
            }
            gsr.handled(true);
        }
        taken
    }

    const POOL: Amounts = [1_000_000, 1_000_000];

    // From p₀ the rule lowers the price first, then raises it while it is below, and so on.
    #[test]
    fn it_takes_the_kind_that_heads_back_to_the_start() {
        let batch = [raise(1_000), raise(1_000), lower(1_000), lower(1_000)];
        assert_eq!(order(POOL, &batch), [2, 0, 3, 1]);
    }

    // Once one kind runs out, the rest go in queue order.
    #[test]
    fn when_one_kind_runs_out_the_other_follows() {
        let batch = [raise(1_000), raise(1_000), lower(1_000), raise(1_000)];
        assert_eq!(order(POOL, &batch), [2, 0, 1, 3]);
    }

    // Requests that do not move the price go first, in queue order, before p₀ is taken.
    #[test]
    fn unpriced_requests_go_first() {
        let batch = [lower(1_000), add_liquidity(), raise(1_000), lower(0)];
        assert_eq!(order(POOL, &batch), [1, 3, 0, 2]);
    }

    // A front-run raising the price, the victim's trade raising it further, and a back-run
    // lowering it: the back-run goes first, then the front-run brings the price back, and the
    // victim's trade is not between them.
    #[test]
    fn a_sandwich_comes_apart() {
        let batch = [raise(20_000), raise(5_000), lower(20_000)];
        assert_eq!(order(POOL, &batch), [2, 0, 1]);
    }

    #[test]
    fn requests_are_sorted_by_the_token_they_pay_in() {
        let a = TRADER;
        let kind = |r: SwapRequest| kind_of(&r.op);

        assert_eq!(kind(SwapRequest::swap_exact_in(&a, 5, 0, 0, &a)), LOWERS);
        assert_eq!(kind(SwapRequest::swap_exact_out(&a, 5, 9, 0, &a)), LOWERS);
        assert_eq!(kind(SwapRequest::swap_exact_in(&a, 5, 0, 1, &a)), RAISES);
        assert_eq!(kind(SwapRequest::swap_exact_out(&a, 5, 9, 1, &a)), RAISES);
        assert_eq!(kind(SwapRequest::swap_exact_in(&a, 0, 0, 0, &a)), UNPRICED);
        assert_eq!(kind(SwapRequest::swap_exact_in(&a, 5, 0, 2, &a)), UNPRICED);
        assert_eq!(
            kind(SwapRequest::add_liquidity(&a, [1, 1], [0, 0], &a)),
            UNPRICED
        );
        assert_eq!(
            kind(SwapRequest::remove_liquidity(&a, 1, [0, 0], &a)),
            UNPRICED
        );
    }
}
