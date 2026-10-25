//! The CLVR ordering rule, applied to one crank's batch.
//!
//! CLVR (McLaughlin, Chemaya, Liu and Malkhi, [*CLVR Ordering of Transactions on AMMs*][paper])
//! orders a batch of trades against one pool so as to keep the pool's price near where the batch
//! found it. It measures the volatility of an order σ as the mean squared log-distance of each
//! intermediate price from the starting price p₀,
//!
//! ```text
//! Vol(σ) = (1/n) Σᵢ (ln p₀ − ln pᵢ)²
//! ```
//!
//! and builds the order greedily: each step takes, of the trades not yet placed, the one that leaves
//! the price nearest p₀.
//!
//! The order is a function of the batch and the pool's reserves alone, which is what makes it
//! worth having on a chain whose cranks are permissionless: whoever cranks has no say in it, so
//! there is nothing to gain by being the one to crank. Nor is there in arranging a 3-trade sandwich
//! -- buy ahead of a victim, sell behind it -- which the paper shows CLVR undoes: the attacker's two
//! legs all but cancel, so once either has moved the price, the other is the trade that brings it
//! back toward p₀, and is placed next. The victim's trade is never left between them.
//!
//! # Two queues
//!
//! A scan of every remaining trade at each step makes CLVR O(n²). The paper's appendix gets
//! O(n log n) from two observations, which this module follows:
//!
//! * A trade either lowers the price or raises it, depending only on which token it pays in. With
//!   the price p = reserve1 / reserve0, paying token0 in lowers it, and paying token1 in raises it.
//! * Among trades going the same way, a larger trade moves the price further.
//!
//! So the trades go in two queues, one per direction, each sorted by size. From a price above p₀,
//! every price-raising trade moves away from p₀ and the smallest of them moves least; the best
//! price-lowering trade is one of the two either side of the size that would land exactly on p₀,
//! which a binary search finds. From below p₀ the roles swap. Each step therefore looks at no more
//! than a handful of trades.
//!
//! Each queue holds two sorted runs rather than one. An exact-in trade is sized by what it pays,
//! and an exact-out trade by what it receives, and which of two such trades moves the price further
//! depends on the reserves when they are compared -- so the two kinds cannot share a sorted order
//! that stays valid as the batch proceeds. Within a run, size order is price-impact order whatever
//! the reserves.
//!
//! # What CLVR does not order
//!
//! Adding and removing liquidity happen at the pool's current ratio, so they do not move its price
//! and CLVR has nothing to say about where they go. They run first, in queue order: every provider
//! in a batch then enters or leaves at the same price, and the batch's trades meet the pool depth
//! that the batch's providers asked for. A malformed swap (a zero amount, or a token index other
//! than 0 or 1) is priced by nobody either, and runs with them, to fail.
//!
//! Slippage limits play no part in the order, as in the paper: a trade is placed by the price it
//! would leave, and a trade whose limit then refuses it changes nothing, so the next step starts
//! from the same price. Ties go to the request the queue yielded first.
//!
//! [paper]: https://arxiv.org/abs/2408.02634

use alloc::vec::Vec;
use core::cmp::Ordering;
use swap_if::{Amount, Amounts, SwapOp, SwapRequest, U256};

/// The largest reserve the pair will record (`swap_pair`'s `BALANCE_MAX`): a trade that would push
/// a reserve past it fails.
const BALANCE_MAX: Amount = i128::MAX as Amount;

/// What a CLVR crank may spend per request beyond handling it: taking it out of the queue and
/// decoding it, placing it, and reading the pool's reserves when the model has none.
///
/// Calibrated on a devnode by `scripts/swap-gas-calibrate.sh` (what a crank spent beyond its
/// handler calls, less what `swap-driver`'s did), and held at about twice the most it came to. The
/// dearest batch per request is the smallest: a batch of one cost some 133k (most of it the first
/// read of the pool's state, which touches the LP token cold), two 74k a request, five 47k. Past that, placing a request costs more as the batch grows -- `clvr-bench` measured
/// the ordering alone at 9k a request for one trade, 41k for 32 and 59k for 128 -- but the read is
/// shared, so no batch up to [`MAX_BATCH`] comes near the first.
pub const SEQUENCE_GAS: u64 = 270_000;

/// The most requests a CLVR crank orders at once: what fits in the driver's memory, which holds the
/// whole batch.
///
/// A guest has 64 KiB of memory unless its artifact declares more, and its allocator never frees.
/// On the RV32 executor (`tests/pool.rs`'s `the_largest_batch_fits`, under `guest_test`) a crank of
/// 132 trades fitted and one of 136 faulted; this keeps some 15% in hand. It also keeps a crank of
/// swaps, at five events each, well inside the 1000 a transaction may emit.
pub const MAX_BATCH: u32 = 112;

/// A CLVR ordering of one batch, handing the batch's requests out one at a time, for the crank in
/// [`queue`](crate::queue).
///
/// It keeps its own model of the pool's reserves, advancing it by each trade that succeeds as the
/// handler would. It reads the real reserves from `read_reserves` when it has no model: before the
/// first trade, after a liquidity operation, and if a trade the model thought impossible
/// succeeded. The model is only ever a guide to the order -- the handler prices every request
/// against the live reserves -- so a model gone wrong (tokens sent to the pool outside a trade,
/// say) makes the order less good, never a trade wrong.
pub struct Clvr<F = fn() -> Amounts> {
    // Each request's trade, by batch index: `None` for a request CLVR does not price.
    trades: Vec<Option<Trade>>,

    // The requests CLVR does not price, in queue order. (Reversed, so the next is the last.)
    unpriced: Vec<usize>,

    // The two queues, indexed by the token a trade pays in: each holds one run per `Kind`, of batch
    // indices sorted by size (and ties in queue order).
    queues: [[Vec<usize>; 2]; 2],

    // The reserves at which p₀ was taken: the pool's, when the first trade was placed.
    start: Option<Amounts>,

    // The pool's reserves now, as far as this can tell; `None` when it cannot.
    reserves: Option<Amounts>,

    read_reserves: F,

    // The request chosen last, while its outcome is pending.
    chosen: Option<usize>,
}

impl<F: FnMut() -> Amounts> Clvr<F> {
    /// Prepare to order `batch`, against the reserves that `read_reserves` reports when asked.
    pub fn new(batch: &[SwapRequest], read_reserves: F) -> Self {
        let trades: Vec<Option<Trade>> = batch.iter().map(|r| Trade::of(&r.op)).collect();

        // Each list is allocated once at the length it will have, since memory is never given back.
        let mut lengths = [[0; 2]; 2];
        for t in trades.iter().flatten() {
            lengths[t.in_index][t.kind as usize] += 1;
        }
        let unpriced_len = trades.iter().filter(|t| t.is_none()).count();
        let mut unpriced = Vec::with_capacity(unpriced_len);
        let mut queues: [[Vec<usize>; 2]; 2] = lengths.map(|q| q.map(Vec::with_capacity));
        for (k, trade) in trades.iter().enumerate() {
            match trade {
                Some(t) => {
                    // Into its run by size, behind any of the same size: those came first.
                    let run = &mut queues[t.in_index][t.kind as usize];
                    let at = run.partition_point(|&j| size(&trades, j) <= t.size);
                    run.insert(at, k);
                }
                None => unpriced.push(k),
            }
        }
        unpriced.reverse();

        Clvr {
            trades,
            unpriced,
            queues,
            start: None,
            reserves: None,
            read_reserves,
            chosen: None,
        }
    }

    // Place the next trade: the one leaving the price nearest p₀.
    fn next_trade(&mut self) -> usize {
        let r = *self.reserves.get_or_insert_with(&mut self.read_reserves);
        let p0 = *self.start.get_or_insert(r);

        // A pool without both reserves has no price to stay near, and every trade against it fails
        // alike, so take them in any order.
        let priced = r[0] > 0 && r[1] > 0 && p0[0] > 0 && p0[1] > 0;
        let (queue, kind, at) = if priced {
            self.nearest(r, p0)
        } else {
            self.earliest()
        };

        self.queues[queue][kind].remove(at)
    }

    // The queue position of the trade that would leave the reserves `r` nearest p₀ (the price of
    // `p0`); of equally near ones, the earliest in the batch.
    fn nearest(&self, r: Amounts, p0: Amounts) -> Place {
        let mut best: Option<(Rank, Place)> = None;

        for queue in 0..2 {
            for kind in 0..2 {
                for at in self.candidates(queue, kind, r, p0).into_iter().flatten() {
                    let k = self.queues[queue][kind][at];
                    let distance = self.trade(k).after(r).map(|a| Distance::new(a, p0));

                    let rank = (distance.is_none(), distance, k);
                    if best.as_ref().is_none_or(|(b, _)| rank < *b) {
                        best = Some((rank, (queue, kind, at)));
                    }
                }
            }
        }

        match best {
            Some(((false, _, _), place)) => place,
            // Nothing left can execute against these reserves.
            _ => self.earliest(),
        }
    }

    // Within one run, the positions of the trades that might leave the price nearest p₀.
    //
    // The price a trade leaves moves monotonically with its size, so the distance from p₀ along a
    // run falls until the size that would land on p₀, and rises after it. The nearest trade in the
    // run is therefore one of the two around that crossing -- or the smallest, if every trade in
    // the run moves the price away.
    fn candidates(&self, queue: usize, kind: usize, r: Amounts, p0: Amounts) -> [Option<usize>; 2] {
        let run = &self.queues[queue][kind];
        if run.is_empty() {
            return [None, None];
        }

        // Paying token0 in lowers the price, so those trades approach p₀ from above it; paying
        // token1 in raises it, approaching from below.
        let approaches_from = if queue == 0 {
            Ordering::Greater
        } else {
            Ordering::Less
        };

        if side(r, p0) != approaches_from {
            return [Some(0), None];
        }

        // The first trade that would reach p₀ or pass it. (One that cannot execute at all is too
        // large to, and so is past it.)
        let crossing = run.partition_point(|&k| {
            self.trade(k)
                .after(r)
                .is_some_and(|a| side(a, p0) == approaches_from)
        });

        // The last trade short of p₀ -- or rather the first of that size, so that ties go to the
        // earliest.
        let short = crossing.checked_sub(1).map(|last| {
            let size = self.trade(run[last]).size;
            run.partition_point(|&k| self.trade(k).size < size)
        });
        let past = (crossing < run.len()).then_some(crossing);

        [short, past]
    }

    // The queue position of the earliest trade left in the batch.
    fn earliest(&self) -> Place {
        let mut earliest: Option<(usize, Place)> = None;
        for queue in 0..2 {
            for kind in 0..2 {
                for (at, &k) in self.queues[queue][kind].iter().enumerate() {
                    if earliest.is_none_or(|(e, _)| k < e) {
                        earliest = Some((k, (queue, kind, at)));
                    }
                }
            }
        }

        earliest.expect("a trade is left to place").1
    }

    fn trade(&self, k: usize) -> Trade {
        self.trades[k].expect("only trades are queued")
    }
}

impl<F: FnMut() -> Amounts> Clvr<F> {
    /// The batch index of the next request to handle: one not yet chosen.
    pub fn choose(&mut self) -> usize {
        let k = match self.unpriced.pop() {
            Some(k) => k,
            None => self.next_trade(),
        };
        self.chosen = Some(k);
        k
    }

    /// Report how the request just chosen fared: `true` if it was handled, `false` if handling it
    /// failed (and so changed nothing).
    pub fn handled(&mut self, ok: bool) {
        let k = self.chosen.take().expect("a request was chosen");

        // A request that failed changed nothing.
        if !ok {
            return;
        }

        self.reserves = match (self.trades[k], self.reserves) {
            // `None` if the model thought this trade impossible: the reserves are not what it
            // thinks, so it reads them afresh.
            (Some(trade), Some(r)) => trade.after(r),
            // A liquidity operation changed the reserves.
            _ => None,
        };
    }
}

// Where a trade waits: its queue, its run in that queue, and its position in the run.
type Place = (usize, usize, usize);

// How a trade ranks for the next place: nearest first, a trade that cannot execute counting as
// infinitely far; then the earliest in the batch.
type Rank = (bool, Option<Distance>, usize);

// The size `trades[k]` is sorted by.
fn size(trades: &[Option<Trade>], k: usize) -> Amount {
    trades[k].map_or(0, |t| t.size)
}

/// What a trade is sized by: what it pays (`ExactIn`), or what it receives (`ExactOut`).
#[derive(Clone, Copy)]
enum Kind {
    ExactIn = 0,
    ExactOut = 1,
}

/// A swap, as far as its place in the order goes.
#[derive(Clone, Copy)]
struct Trade {
    // The index of the token it pays in.
    in_index: usize,
    kind: Kind,
    size: Amount,
}

impl Trade {
    // The trade `op` makes, if it is one CLVR can price.
    fn of(op: &SwapOp) -> Option<Trade> {
        let (in_index, kind, size) = match op {
            SwapOp::SwapExactIn(req) => (req.in_index, Kind::ExactIn, req.amount_in),
            SwapOp::SwapExactOut(req) => (req.in_index, Kind::ExactOut, req.amount_out),
            SwapOp::AddLiquidity(_) | SwapOp::RemoveLiquidity(_) => return None,
        };

        (in_index <= 1 && size > 0).then_some(Trade {
            in_index: in_index as usize,
            kind,
            size,
        })
    }

    /// The reserves this trade would leave, executed against `r`; `None` if it cannot execute
    /// whatever its limits, being too large for the reserves.
    ///
    /// The amounts are the handler's (`swap_handler`'s `get_amount_out` and `get_amount_in`, with
    /// UniswapV2's 0.3% fee); the pair then records its balances, the reserves plus what was paid
    /// in, less what was paid out.
    fn after(&self, r: Amounts) -> Option<Amounts> {
        let (i, o) = (self.in_index, 1 - self.in_index);

        let (paid, received) = match self.kind {
            Kind::ExactIn => (self.size, amount_out(self.size, r[i], r[o])?),
            Kind::ExactOut => (amount_in(self.size, r[i], r[o])?, self.size),
        };

        let mut after = r;
        after[i] = r[i].checked_add(paid).filter(|&b| b <= BALANCE_MAX)?;
        after[o] = r[o] - received;
        Some(after)
    }
}

// What paying `amount_in` buys, as `swap_handler`'s `get_amount_out` computes it; `None` where
// that would overflow.
fn amount_out(amount_in: Amount, reserve_in: Amount, reserve_out: Amount) -> Option<Amount> {
    let amount_in_with_fee = U256::from(amount_in) * 997;
    let numerator = amount_in_with_fee.checked_mul(U256::from(reserve_out))?;
    let denominator = U256::from(reserve_in) * 1000 + amount_in_with_fee;

    // Less than `reserve_out`, so it fits.
    Some((numerator / denominator).try_into().unwrap())
}

// What buying `amount_out` costs, as `swap_handler`'s `get_amount_in` computes it; `None` where it
// would refuse (the pool does not hold that much), or overflow.
fn amount_in(amount_out: Amount, reserve_in: Amount, reserve_out: Amount) -> Option<Amount> {
    if amount_out >= reserve_out {
        return None;
    }

    let numerator = U256::widening_mul(reserve_in, amount_out).checked_mul(U256::from(1000))?;
    let denominator = U256::from(reserve_out - amount_out) * 997;
    let quotient: Amount = (numerator / denominator).try_into().ok()?;

    quotient.checked_add(1)
}

// Where the reserves `r` put the price, relative to p₀ (the price of `p0`).
fn side(r: Amounts, p0: Amounts) -> Ordering {
    // p / p₀ = (r1 / r0) / (p0_1 / p0_0) = (r1 * p0_0) / (r0 * p0_1)
    U256::widening_mul(r[1], p0[0]).cmp(&U256::widening_mul(r[0], p0[1]))
}

/// How far some reserves put the price from p₀: |ln(p / p₀)|, kept exact as the ratio of the
/// larger to the smaller of p and p₀ (cross-multiplied), which orders the same way.
#[derive(Clone, Copy, Debug)]
struct Distance {
    far: U256,
    near: U256,
}

impl Distance {
    fn new(r: Amounts, p0: Amounts) -> Self {
        let p = U256::widening_mul(r[1], p0[0]);
        let p0 = U256::widening_mul(r[0], p0[1]);
        let (far, near) = if p >= p0 { (p, p0) } else { (p0, p) };
        Distance { far, near }
    }
}

impl Ord for Distance {
    fn cmp(&self, other: &Self) -> Ordering {
        // far / near against other.far / other.near, without dividing: both sides are 512 bits.
        let (lo, hi) = self.far.widening_mul_u256(other.near);
        let (other_lo, other_hi) = other.far.widening_mul_u256(self.near);
        (hi, lo).cmp(&(other_hi, other_lo))
    }
}

impl PartialOrd for Distance {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Distance {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Distance {}

#[cfg(test)]
mod tests {
    use super::*;
    use thruput_sdk::ContractAddress;

    const TRADER: ContractAddress = ContractAddress::new([7u8; 32]);

    fn sell0(amount_in: Amount) -> SwapRequest {
        SwapRequest::swap_exact_in(&TRADER, amount_in, 0, 0, &TRADER)
    }

    fn sell1(amount_in: Amount) -> SwapRequest {
        SwapRequest::swap_exact_in(&TRADER, amount_in, 0, 1, &TRADER)
    }

    fn add_liquidity() -> SwapRequest {
        SwapRequest::add_liquidity(&TRADER, [1, 1], [0, 0], &TRADER)
    }

    // Run `batch` through a `Clvr` against a pool that starts at `reserves`, in which the requests
    // `fails` names fail and the rest do what the model expects. Return the order.
    fn clvr_order(batch: &[SwapRequest], reserves: Amounts, fails: &[bool]) -> Vec<usize> {
        let pool = core::cell::Cell::new(reserves);
        let mut clvr = Clvr::new(batch, || pool.get());

        let mut order = Vec::new();
        for _ in 0..batch.len() {
            let k = clvr.choose();
            order.push(k);

            let after = Trade::of(&batch[k].op).and_then(|t| t.after(pool.get()));
            let ok = !fails[k] && after.is_some();
            if ok {
                pool.set(after.unwrap());
            }
            clvr.handled(ok);
        }
        order
    }

    // CLVR as the paper states it, a scan of every remaining trade at each step, under the same
    // conventions: the requests it does not price first, in queue order; then the trade leaving the
    // price nearest p₀, a trade that cannot execute counting as infinitely far, and ties to the
    // earliest.
    fn reference_order(batch: &[SwapRequest], reserves: Amounts, fails: &[bool]) -> Vec<usize> {
        let trades: Vec<Option<Trade>> = batch.iter().map(|r| Trade::of(&r.op)).collect();
        let mut order: Vec<usize> = (0..batch.len()).filter(|&k| trades[k].is_none()).collect();
        let mut left: Vec<usize> = (0..batch.len()).filter(|&k| trades[k].is_some()).collect();

        let p0 = reserves;
        let mut r = reserves;
        while !left.is_empty() {
            let (at, _) = left
                .iter()
                .enumerate()
                .map(|(at, &k)| {
                    let d = trades[k].unwrap().after(r).map(|a| Distance::new(a, p0));
                    (at, (d.is_none(), d, k))
                })
                .min_by(|a, b| a.1.cmp(&b.1))
                .unwrap();

            let k = left.remove(at);
            order.push(k);
            if let Some(a) = trades[k].unwrap().after(r).filter(|_| !fails[k]) {
                r = a;
            }
        }
        order
    }

    // The volatility of executing `order`: the mean squared log-distance of each price from p₀.
    fn volatility(batch: &[SwapRequest], reserves: Amounts, order: &[usize]) -> f64 {
        let ln_p = |r: Amounts| (r[1] as f64).ln() - (r[0] as f64).ln();
        let ln_p0 = ln_p(reserves);

        let mut r = reserves;
        let mut sum = 0.0;
        for &k in order {
            if let Some(a) = Trade::of(&batch[k].op).and_then(|t| t.after(r)) {
                r = a;
            }
            sum += (ln_p(r) - ln_p0).powi(2);
        }
        sum / order.len() as f64
    }

    // A deterministic source of test cases (xorshift64*).
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        fn amount(&mut self, scale: Amount) -> Amount {
            // Spread across orders of magnitude, so that some trades dwarf others.
            let shift = self.below(20) as u32;
            (scale >> shift).max(1) * (1 + self.below(9) as Amount)
        }
    }

    fn random_case(rng: &mut Rng) -> (Vec<SwapRequest>, Amounts, Vec<bool>) {
        let reserves = [rng.amount(1 << 60), rng.amount(1 << 60)];
        let n = 1 + rng.below(40) as usize;

        // (kind, amount, in_index): 0 for exact-in, 1 for exact-out, 2 for adding liquidity.
        let mut specs: Vec<(u8, Amount, u32)> = Vec::new();
        for _ in 0..n {
            let in_index = rng.below(2) as u32;
            let spec = match rng.below(20) {
                0 => (2, 0, 0),
                1 => (0, 0, in_index),
                2 => (0, 1, 2),
                // Repeat an earlier trade, for ties.
                3 | 4 if !specs.is_empty() => specs[rng.below(specs.len() as u64) as usize],
                // Some of these ask for more than the pool holds.
                5..=9 => (1, rng.amount(reserves[1 - in_index as usize]), in_index),
                _ => (0, rng.amount(reserves[in_index as usize] / 2), in_index),
            };
            specs.push(spec);
        }

        let batch = specs
            .into_iter()
            .map(|(kind, amount, in_index)| match kind {
                0 => SwapRequest::swap_exact_in(&TRADER, amount, 0, in_index, &TRADER),
                1 => SwapRequest::swap_exact_out(&TRADER, amount, 0, in_index, &TRADER),
                _ => add_liquidity(),
            })
            .collect();

        // Some trades fail at their limits.
        let fails = (0..n).map(|_| rng.below(8) == 0).collect();

        (batch, reserves, fails)
    }

    // The two-queue CLVR places every trade exactly where a scan of all of them would.
    #[test]
    fn two_queues_order_as_a_full_scan_does() {
        let mut rng = Rng(0x00C1_7700_5EED);
        for case in 0..2_000 {
            let (batch, reserves, fails) = random_case(&mut rng);
            assert_eq!(
                clvr_order(&batch, reserves, &fails),
                reference_order(&batch, reserves, &fails),
                "case {case}: reserves {reserves:?}, batch {batch:?}, fails {fails:?}"
            );
        }
    }

    // Every request in the batch is handed out exactly once.
    #[test]
    fn every_request_is_chosen_once() {
        let mut rng = Rng(0x0BA7_C4E5);
        for _ in 0..200 {
            let (batch, reserves, fails) = random_case(&mut rng);
            let mut order = clvr_order(&batch, reserves, &fails);
            order.sort_unstable();
            assert_eq!(order, (0..batch.len()).collect::<Vec<_>>());
        }
    }

    // Liquidity operations, and swaps CLVR cannot price, run first and in queue order.
    #[test]
    fn unpriced_requests_run_first_in_queue_order() {
        let batch = [
            sell0(500),
            add_liquidity(),
            sell1(500),
            SwapRequest::swap_exact_in(&TRADER, 0, 0, 0, &TRADER),
            add_liquidity(),
        ];
        let order = clvr_order(&batch, [1_000_000, 1_000_000], &[false; 5]);
        assert_eq!(&order[..3], &[1, 3, 4]);
    }

    // A sandwich -- a buy ahead of the victim's, and a sell behind it -- comes apart. From p₀ every
    // trade moves the price away, so the smallest goes first: the victim trades at p₀, and the
    // attacker's front-run, which needed to go first, goes last.
    #[test]
    fn a_sandwich_comes_apart() {
        let reserves = [1_000_000_000, 1_000_000_000];
        let front_run = sell1(20_000_000);
        let victim = sell1(5_000_000);
        let back_run = sell0(20_000_000);

        let batch = [front_run, victim, back_run];
        let order = clvr_order(&batch, reserves, &[false; 3]);
        assert_eq!(
            order,
            vec![1, 2, 0],
            "victim, then the back-run, then the front-run"
        );

        // ... and the pool's price strays less than it would have in the attacker's order.
        assert!(volatility(&batch, reserves, &order) < volatility(&batch, reserves, &[0, 1, 2]));
    }

    // Opposing flow is interleaved so that the price oscillates tightly around p₀, where queue
    // order would run it far off in one direction and then back.
    #[test]
    fn opposing_flow_is_interleaved() {
        let reserves = [1_000_000_000, 1_000_000_000];
        let batch = [
            sell0(10_000_000),
            sell0(10_000_000),
            sell0(10_000_000),
            sell1(10_000_000),
            sell1(10_000_000),
            sell1(10_000_000),
        ];
        let order = clvr_order(&batch, reserves, &[false; 6]);

        let direction = |k: usize| k < 3;
        assert!(
            order.windows(2).all(|w| direction(w[0]) != direction(w[1])),
            "{order:?} alternates directions"
        );
        assert!(
            volatility(&batch, reserves, &order)
                < volatility(&batch, reserves, &[0, 1, 2, 3, 4, 5])
        );
    }

    // The model's amounts are the handler's.
    #[test]
    fn the_model_prices_trades_as_the_handler_does() {
        use swap_if::U256;

        // `swap_handler`'s library, restated (it is private to that crate).
        fn get_amount_out(amount_in: Amount, r: Amounts) -> Amount {
            let with_fee = U256::from(amount_in) * 997;
            ((with_fee * U256::from(r[1])) / (U256::from(r[0]) * 1000 + with_fee))
                .try_into()
                .unwrap()
        }
        fn get_amount_in(amount_out: Amount, r: Amounts) -> Amount {
            let q: Amount = ((U256::from(r[0]) * U256::from(amount_out) * 1000)
                / (U256::from(r[1] - amount_out) * 997))
                .try_into()
                .unwrap();
            q + 1
        }

        let mut rng = Rng(0xFEE5);
        for _ in 0..1_000 {
            let r = [rng.amount(1 << 80), rng.amount(1 << 80)];
            let a = rng.amount(r[0]);
            assert_eq!(amount_out(a, r[0], r[1]), Some(get_amount_out(a, r)));

            let b = rng.amount(r[1] / 20).min(r[1] / 2).max(1);
            assert_eq!(amount_in(b, r[0], r[1]), Some(get_amount_in(b, r)));
        }
    }
}
