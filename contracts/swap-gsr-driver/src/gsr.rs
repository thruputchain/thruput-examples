//! The Greedy Sequencing Rule, applied to one crank.
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
//! waits in a lane of its own, in queue order, and each step takes the head of one lane. The crank
//! streams through the lanes as a plain crank streams through its queue.
//!
//! With the price p = reserve1 / reserve0, a trade paying token0 in lowers it, and one paying token1
//! in raises it. Adding and removing liquidity leave it where it is, so they have a lane of their
//! own, and go first. A malformed swap (a zero amount, or a token index other than 0 or 1) goes with
//! them, to fail. At p₀ exactly this takes a trade that lowers the price; either fixed choice keeps
//! the rule's guarantee.
//!
//! CLVR (`swap-clvr-driver`) refines this: rather than any trade on the right side, it takes the one
//! that leaves the price nearest p₀, which keeps the price closer to p₀ through the batch -- at the
//! cost of having to see, and sort, the whole batch first.
//!
//! [paper]: https://arxiv.org/abs/2209.15569

use core::cmp::Ordering;
use swap_if::{Amounts, SwapOp, U256};

/// The lanes of a GSR driver's queue.
pub const LANES: usize = 3;

/// Requests that do not move the price: liquidity operations, and malformed swaps.
pub const UNPRICED: usize = 0;

/// Trades paying token0 in, which lower the price.
pub const LOWERS: usize = 1;

/// Trades paying token1 in, which raise the price.
pub const RAISES: usize = 2;

/// What a GSR crank may spend per request beyond handling it: finding whether its lane has more,
/// and reading the pool's reserves afresh after it.
///
/// A placeholder, not yet calibrated on a devnode. Measure it as the other gas figures are, with
/// `scripts/swap-gas-calibrate.sh`, before relying on it.
pub const PICK_GAS: u64 = 150_000;

/// The lane a request waits in.
pub fn lane_of(op: &SwapOp) -> usize {
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

/// GSR over one crank, as a [`batch_driver::LanePicker`].
///
/// It reads the pool's reserves from `read_reserves` when it needs them: before the first trade,
/// and after any request that succeeded. A rule that only asks which side of p₀ the price is on can
/// afford to ask the pool itself, so there is no model of the reserves to go wrong.
pub struct Gsr<F = fn() -> Amounts> {
    read_reserves: F,

    // The reserves at which p₀ was taken: the pool's, when the first trade was taken.
    start: Option<Amounts>,

    // The pool's reserves now, if known.
    reserves: Option<Amounts>,
}

impl<F: FnMut() -> Amounts> Gsr<F> {
    pub fn new(read_reserves: F) -> Self {
        Gsr {
            read_reserves,
            start: None,
            reserves: None,
        }
    }
}

impl<F: FnMut() -> Amounts> batch_driver::LanePicker<LANES> for Gsr<F> {
    const GAS_PER_REQUEST: u64 = PICK_GAS;

    fn next(&mut self, waiting: &[bool; LANES]) -> usize {
        if waiting[UNPRICED] {
            return UNPRICED;
        }

        let r = *self.reserves.get_or_insert_with(&mut self.read_reserves);
        let p0 = *self.start.get_or_insert(r);

        let toward = if side(r, p0) == Ordering::Less {
            RAISES
        } else {
            LOWERS
        };

        if waiting[toward] {
            toward
        } else {
            LOWERS + RAISES - toward
        }
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
    use batch_driver::LanePicker;
    use core::cell::Cell;

    // Run GSR over lanes holding `lanes[l]` trades of the given sizes (each paying `size` in),
    // against a constant-product pool without fees starting at `reserves`; return the lanes taken.
    fn order(reserves: Amounts, lanes: [&[u128]; LANES]) -> Vec<usize> {
        let pool = Cell::new(reserves);
        let mut gsr = Gsr::new(|| pool.get());
        let mut heads = [0; LANES];

        let mut taken = Vec::new();
        loop {
            let waiting = core::array::from_fn(|l| heads[l] < lanes[l].len());
            if !waiting.contains(&true) {
                break;
            }

            let lane = gsr.next(&waiting);
            let size = lanes[lane][heads[lane]];
            heads[lane] += 1;
            taken.push(lane);

            let [r0, r1] = pool.get();
            match lane {
                LOWERS => pool.set([r0 + size, r0 * r1 / (r0 + size)]),
                RAISES => pool.set([r0 * r1 / (r1 + size), r1 + size]),
                _ => {}
            }
            gsr.handled(true);
        }
        taken
    }

    // From p₀ the rule lowers the price first, then raises it while it is below, and so on.
    #[test]
    fn it_takes_the_lane_that_heads_back_to_the_start() {
        let reserves = [1_000_000, 1_000_000];
        assert_eq!(
            order(reserves, [&[], &[1_000, 1_000], &[1_000, 1_000]]),
            [LOWERS, RAISES, LOWERS, RAISES]
        );
    }

    // Once one kind runs out, the rest go in queue order.
    #[test]
    fn when_one_lane_runs_out_the_other_drains() {
        let reserves = [1_000_000, 1_000_000];
        assert_eq!(
            order(reserves, [&[], &[1_000], &[1_000, 1_000, 1_000]]),
            [LOWERS, RAISES, RAISES, RAISES]
        );
    }

    // Requests that do not move the price go first, before p₀ is taken.
    #[test]
    fn unpriced_requests_go_first() {
        let reserves = [1_000_000, 1_000_000];
        assert_eq!(
            order(reserves, [&[0, 0], &[1_000], &[1_000]]),
            [UNPRICED, UNPRICED, LOWERS, RAISES]
        );
    }

    // A front-run raising the price, the victim's trade raising it further, and a back-run
    // lowering it: the back-run goes first, then the front-run brings the price back, and the
    // victim's trade is not between them.
    #[test]
    fn a_sandwich_comes_apart() {
        let reserves = [1_000_000, 1_000_000];
        // The raising lane holds the front-run, then the victim's trade.
        assert_eq!(
            order(reserves, [&[], &[20_000], &[20_000, 5_000]]),
            [LOWERS, RAISES, RAISES]
        );
    }

    #[test]
    fn requests_are_laned_by_the_token_they_pay_in() {
        use swap_if::SwapRequest;
        use thruput_sdk::ContractAddress;

        let a = ContractAddress::new([1; 32]);
        let lane = |r: SwapRequest| lane_of(&r.op);

        assert_eq!(lane(SwapRequest::swap_exact_in(&a, 5, 0, 0, &a)), LOWERS);
        assert_eq!(lane(SwapRequest::swap_exact_out(&a, 5, 9, 0, &a)), LOWERS);
        assert_eq!(lane(SwapRequest::swap_exact_in(&a, 5, 0, 1, &a)), RAISES);
        assert_eq!(lane(SwapRequest::swap_exact_out(&a, 5, 9, 1, &a)), RAISES);
        assert_eq!(lane(SwapRequest::swap_exact_in(&a, 0, 0, 0, &a)), UNPRICED);
        assert_eq!(lane(SwapRequest::swap_exact_in(&a, 5, 0, 2, &a)), UNPRICED);
        assert_eq!(
            lane(SwapRequest::add_liquidity(&a, [1, 1], [0, 0], &a)),
            UNPRICED
        );
        assert_eq!(
            lane(SwapRequest::remove_liquidity(&a, 1, [0, 0], &a)),
            UNPRICED
        );
    }
}
