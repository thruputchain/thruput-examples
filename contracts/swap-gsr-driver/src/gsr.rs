//! The Greedy Sequencing Rule, applied to one block's requests.
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
//! A batch is the requests one block enqueued, as the paper's is a block's trades, and the queue
//! hands the rule one batch at a time, oldest first (see [`crate::lanes`]). Were the batch whatever
//! is waiting, requests that keep arriving in a lane the rule prefers could keep an earlier request
//! in another lane waiting for good.
//!
//! A crank can run out of gas partway through a batch, and whoever cranks chooses where. Were the
//! next crank to take the price it found as p₀, that choice would be a say in the order: at p₀ the
//! rule lowers the price, so a crank stopped after a front-run that lowered it would carry on with
//! the next trade that lowers it, the victim's, and not with the back-run the rule owes. So a crank
//! that stops mid-batch stores the batch's p₀, and the one that carries on reads it back.
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
use thruput_sdk::*;

/// The lanes of a GSR driver's queue.
pub const LANES: usize = 3;

/// Requests that do not move the price: liquidity operations, and malformed swaps.
pub const UNPRICED: usize = 0;

/// Trades paying token0 in, which lower the price.
pub const LOWERS: usize = 1;

/// Trades paying token1 in, which raise the price.
pub const RAISES: usize = 2;

/// What a GSR crank may spend per request beyond handling it: choosing its lane, taking it and
/// finding whether its lane has more, and reading the pool's reserves before the next.
///
/// Calibrated on a devnode by `scripts/swap-gas-calibrate.sh` (what a crank spent beyond its
/// handler calls, less what `swap-driver`'s did), and held at about twice the most it came to: some
/// 93k a request for a batch of one, most of it the first read of the pool's state, which touches
/// the LP token cold; 55k for two, 33k for five.
pub const PICK_GAS: u64 = 190_000;

/// What a GSR crank may spend storing the p₀ of a batch it leaves unfinished: one write.
///
/// Not yet calibrated. It is set at [`batch_driver::CLAIM_GAS`], which pays for a call and a write.
pub const SUSPEND_GAS: u64 = batch_driver::CLAIM_GAS;

/// The p₀ of a batch a crank left unfinished.
#[derive(ReadXDR, WriteXDR, Clone, Copy, Debug, PartialEq, Eq)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
pub struct Start {
    /// The batch: the height of the block that enqueued it.
    pub batch: i64,

    /// The pool's reserves when the batch's first trade was taken.
    pub reserves: Amounts,
}

/// What GSR needs of the pool, and of the driver's storage.
pub trait Pool {
    /// The pool's reserves now.
    fn reserves(&mut self) -> Amounts;

    /// The [`Start`] last given to [`suspend`](Self::suspend), if any.
    fn suspended(&mut self) -> Option<Start>;

    /// Store `start`, replacing any stored before.
    fn suspend(&mut self, start: &Start);
}

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

/// GSR over each batch of a crank, as a [`LanePicker`](crate::lanes::LanePicker).
///
/// It reads the pool's reserves from `pool` when it needs them: before the first trade, and after
/// any request that succeeded. A rule that only asks which side of p₀ the price is on can afford to
/// ask the pool itself, so there is no model of the reserves to go wrong.
pub struct Gsr<P> {
    pool: P,

    // The batch being ordered.
    batch: i64,

    // The reserves at which p₀ was taken: the pool's, when the batch's first trade was taken.
    start: Option<Amounts>,

    // Whether `start` is what the pool has stored for this batch.
    stored: bool,

    // Whether a batch has begun in this crank. Only the first can be one a crank left unfinished.
    begun: bool,

    // The pool's reserves now, if known.
    reserves: Option<Amounts>,
}

impl<P: Pool> Gsr<P> {
    pub fn new(pool: P) -> Self {
        Gsr {
            pool,
            batch: 0,
            start: None,
            stored: false,
            begun: false,
            reserves: None,
        }
    }
}

impl<P: Pool> crate::lanes::LanePicker<LANES> for Gsr<P> {
    const GAS_PER_REQUEST: u64 = PICK_GAS;
    const SUSPEND_GAS: u64 = SUSPEND_GAS;

    fn begin_batch(&mut self, batch: i64) {
        // Each batch is ordered against the price it began at: the price now, unless an earlier
        // crank began it.
        let carried_on = if self.begun {
            None
        } else {
            self.pool.suspended().filter(|start| start.batch == batch)
        };

        self.batch = batch;
        self.start = carried_on.map(|start| start.reserves);
        self.stored = carried_on.is_some();
        self.begun = true;
    }

    fn suspend(&mut self) {
        // With no trade taken yet, the batch has no p₀ to keep.
        if let (Some(reserves), false) = (self.start, self.stored) {
            self.pool.suspend(&Start {
                batch: self.batch,
                reserves,
            });
        }
    }

    fn next(&mut self, waiting: &[bool; LANES]) -> usize {
        if waiting[UNPRICED] {
            return UNPRICED;
        }

        let r = match self.reserves {
            Some(r) => r,
            None => *self.reserves.insert(self.pool.reserves()),
        };
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
    U256::widening_mul_u128(r[1], p0[0]).cmp(&U256::widening_mul_u128(r[0], p0[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lanes::LanePicker;
    use core::cell::Cell;

    // A constant-product pool without fees, and the driver's one stored `Start`.
    struct TestPool {
        reserves: Cell<Amounts>,
        stored: Cell<Option<Start>>,
    }

    impl TestPool {
        fn new(reserves: Amounts) -> Self {
            TestPool {
                reserves: Cell::new(reserves),
                stored: Cell::new(None),
            }
        }

        // Trade `size` in from `lane`.
        fn trade(&self, lane: usize, size: u128) {
            let [r0, r1] = self.reserves.get();
            match lane {
                LOWERS => self.reserves.set([r0 + size, r0 * r1 / (r0 + size)]),
                RAISES => self.reserves.set([r0 * r1 / (r1 + size), r1 + size]),
                _ => {}
            }
        }
    }

    impl Pool for &TestPool {
        fn reserves(&mut self) -> Amounts {
            self.reserves.get()
        }

        fn suspended(&mut self) -> Option<Start> {
            self.stored.get()
        }

        fn suspend(&mut self, start: &Start) {
            self.stored.set(Some(*start));
        }
    }

    // Run GSR over one batch, in lanes holding `lanes[l]` trades of the given sizes (each paying
    // `size` in), against a pool starting at `reserves`; return the lanes taken.
    fn order(reserves: Amounts, lanes: [&[u128]; LANES]) -> Vec<usize> {
        let pool = TestPool::new(reserves);
        cranks(&pool, lanes, &[usize::MAX]).concat()
    }

    // The same, over a pool as it stands, in cranks that stop after `sizes[i]` requests; return the
    // lanes each took.
    fn cranks(pool: &TestPool, lanes: [&[u128]; LANES], sizes: &[usize]) -> Vec<Vec<usize>> {
        let mut heads = [0; LANES];
        let waiting = |heads: &[usize; LANES]| core::array::from_fn(|l| heads[l] < lanes[l].len());

        sizes
            .iter()
            .map(|&size| {
                let mut gsr = Gsr::new(pool);
                let mut taken = Vec::new();

                while waiting(&heads).contains(&true) && taken.len() < size {
                    if taken.is_empty() {
                        gsr.begin_batch(7);
                    }

                    let lane = gsr.next(&waiting(&heads));
                    pool.trade(lane, lanes[lane][heads[lane]]);
                    heads[lane] += 1;
                    taken.push(lane);
                    gsr.handled(true);
                }

                if waiting(&heads).contains(&true) {
                    gsr.suspend();
                }
                taken
            })
            .collect()
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

    // Each batch is ordered against the price it begins at, not the price the crank began at.
    #[test]
    fn a_new_batch_takes_the_price_afresh() {
        let pool = TestPool::new([1_000_000, 1_000_000]);
        let mut gsr = Gsr::new(&pool);
        let both = [false, true, true];

        // A batch whose one trade lowers the price. Against the price it began at, a second batch
        // would begin by raising it.
        gsr.begin_batch(7);
        assert_eq!(gsr.next(&[false, true, false]), LOWERS);
        pool.trade(LOWERS, 100_000);
        gsr.handled(true);
        assert_eq!(gsr.next(&both), RAISES);

        // But the price it finds is its own p₀, and at p₀ the rule lowers the price.
        gsr.begin_batch(8);
        assert_eq!(gsr.next(&both), LOWERS);
    }

    // Where a crank stops is no say in the order: a batch split over cranks, wherever, comes out
    // as it would from one. Here a front-run that lowers the price, the victim's trade after it in
    // its lane, and a back-run. A crank that took the price it found as p₀ would, stopped after
    // the front-run, carry on with the victim's trade.
    #[test]
    fn a_batch_split_over_cranks_keeps_its_order() {
        let reserves = [1_000_000, 1_000_000];
        let lanes: [&[u128]; LANES] = [&[], &[20_000, 5_000], &[20_000]];
        let whole = order(reserves, lanes);
        assert_eq!(whole, [LOWERS, RAISES, LOWERS]);

        for sizes in [[1, 1, 1], [1, 2, 0], [2, 1, 0]] {
            let pool = TestPool::new(reserves);
            assert_eq!(cranks(&pool, lanes, &sizes).concat(), whole);
            assert_eq!(
                pool.stored.get().map(|start| start.reserves),
                Some(reserves)
            );
        }
    }

    // A stored p₀ belongs to its batch, and no other.
    #[test]
    fn another_batch_does_not_carry_on_from_a_stored_start() {
        let pool = TestPool::new([1_000_000, 1_000_000]);
        (&pool).suspend(&Start {
            batch: 7,
            reserves: [1_000_000, 4_000_000],
        });

        // Against the stored p₀ the price is below, and the rule would raise it.
        let mut gsr = Gsr::new(&pool);
        gsr.begin_batch(8);
        assert_eq!(gsr.next(&[false, true, true]), LOWERS);

        let mut gsr = Gsr::new(&pool);
        gsr.begin_batch(7);
        assert_eq!(gsr.next(&[false, true, true]), RAISES);
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
