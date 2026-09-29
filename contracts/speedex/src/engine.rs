//! The clearing engine: SPEEDEX's arithmetic, with no storage behind it.
//!
//! A batch is described to the engine as a list of [`Bucket`]s -- for each orderbook (a `sell`
//! asset and a `buy` asset) and each price level on the [grid](Grid), the total amount
//! offered at that level. The engine never sees individual offers: it computes one price per asset
//! by [tâtonnement](tatonnement) over that aggregate supply and demand, then the amount each
//! orderbook trades by solving the paper's linear program as what it is, a [circulation](clear) on
//! the graph of assets, in exact integer arithmetic. [`fill`] then tells any single offer, from
//! its orderbook's [`BookFill`] alone, what it sold and what it bought -- which is what lets the
//! contract settle offers one at a time, in any order, in parallel.
//!
//! # Fixed point
//!
//! Every fraction here is Q32: an integer whose value is `x / 2^32`, with [`ONE`] as one. Prices are
//! Q32 too, and only their ratios mean anything: `p_sell / p_buy` is how many units of the buy
//! asset one unit of the sell asset is worth. [`normalize`] pins the largest price of a batch to
//! [`PRICE_ANCHOR`] and floors the rest at [`MIN_PRICE`], which is what keeps every per-offer
//! product within `u128` for offers below [`MAX_AMOUNT`], and the aggregate arithmetic within
//! `U256` for buckets that may total anything up to `i128::MAX`.

#![allow(clippy::needless_range_loop)]

use alloc::vec::Vec;
use sdk::{U256, checked_mul_div_u128};

/// The most assets one exchange can value. Arrays are sized by this; a batch uses the first `n`.
pub const MAX_ASSETS: usize = 8;
/// Orderbooks are indexed by [`book`], which leaves the diagonal unused.
pub const MAX_BOOKS: usize = MAX_ASSETS * MAX_ASSETS;

/// A valuation, Q32.
pub type Price = u64;
/// One price per asset; entries at or past the exchange's asset count are zero.
pub type Prices = [Price; MAX_ASSETS];

/// One in Q32.
pub const ONE: u128 = 1 << 32;
/// One as a [`Price`]: a ratio of exactly one.
pub const PRICE_ONE: Price = 1 << 32;
/// What [`normalize`] scales the largest price of a batch to.
pub const PRICE_ANCHOR: Price = 1 << 56;
/// The smallest price [`normalize`] allows, so that no ratio exceeds `2^48`.
pub const MIN_PRICE: Price = 1 << 8;
/// Offers must be smaller than this so that `amount * ratio` fits in `u128` at every ratio the
/// prices admit. A histogram cell -- the total of a level's offers -- is an `i128`, and the engine
/// is exact for any total up to `i128::MAX`.
pub const MAX_AMOUNT: u128 = 1 << 80;
/// Offers must be at least this. Each rounding in [`fill`] costs the seller less than a unit, so the
/// smallest offer bounds how far an effective price can fall short of its limit: for an offer of
/// this size, under a few parts in `2^15`.
pub const MIN_AMOUNT: u128 = 1 << 16;

/// The widest grid: limit ratios from `2^-8` to just under `2^8`.
pub const MAX_OCTAVES: u32 = 8;
/// The finest grid: `2^16` levels to the doubling, a step of about one part in 100,000.
pub const MAX_LEVEL_BITS: u32 = 16;
/// The most levels any grid has (`2^20`), so a level fits in 20 bits.
pub const MAX_LEVELS: u32 = (2 * MAX_OCTAVES) << MAX_LEVEL_BITS;

// 2^(2^-j) for j in 1..=16, Q62: the factors a fractional power of two is assembled from.
const ROOTS_OF_TWO: [u64; 16] = [
    6_521_908_912_666_391_106,
    5_484_249_825_272_419_512,
    5_029_079_263_719_320_435,
    4_815_862_801_830_788_490,
    4_712_668_792_719_003_884,
    4_661_903_986_662_671_290,
    4_636_727_017_470_743_990,
    4_624_189_567_668_517_720,
    4_617_933_561_212_708_776,
    4_614_808_732_577_250_068,
    4_613_247_111_281_068_008,
    4_612_466_498_810_092_975,
    4_612_076_242_109_103_707,
    4_611_881_126_141_011_236,
    4_611_783_571_252_412_754,
    4_611_734_794_581_956_353,
];

/// Width of the smoothing band as a fraction of the level: for tâtonnement, an offer at level `L`
/// executes fully once the ratio reaches `L * (1 + 2^-SMOOTH_SHIFT)`, and proportionally in
/// between. The band is what gives tâtonnement a gradient to follow instead of a step. For the
/// circulation, buckets past the band are lower bounds (they must execute) and buckets inside it
/// are upper bounds (they may).
pub const SMOOTH_SHIFT: u32 = 6;
/// The most price-update rounds a configuration may allow tâtonnement. Each round costs a pass
/// over the batch's buckets; how many a batch needs to reach [`TOLERANCE`] is what
/// `tests/quality.rs` measures.
pub const MAX_ROUNDS: u32 = 256;
/// The most cycles [`clear`] will push flow around. Each is an integer step, so this bounds the
/// clearing's work; a circulation left short of the optimum is still exact, just smaller.
pub const MAX_CANCELLATIONS: u32 = 256;
/// Tâtonnement stops once the clearing error is below one part in this of the traded volume.
pub const TOLERANCE: u128 = 1000;
// Step-size control, Q32: where each asset's step starts, the most it grows to, and the least
// worth continuing with.
const STEP_INIT: u128 = ONE / 8;
const STEP_MAX: u128 = ONE / 2;
const STEP_MIN: u128 = ONE >> 12;

/// The total amount offered at one price level of one orderbook.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bucket {
    /// The orderbook: asset indices, narrow because a clearing holds every bucket of its batch in
    /// the guest's memory.
    pub sell: u8,
    pub buy: u8,
    /// The grid level.
    pub level: u32,
    /// The level's limit ratio (see [`Grid::ratio`]): the least `p_sell / p_buy` at which these
    /// offers execute.
    pub limit: Price,
    pub amount: u128,
}

/// What clearing a batch decided about prices; what each orderbook trades is its [`BookFill`].
#[sdk::contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clearing {
    /// The valuation prices, normalized.
    pub prices: Prices,
    /// How many price-update rounds tâtonnement ran.
    pub rounds: u32,
    /// How many cycles the circulation was pushed around; see [`MAX_CANCELLATIONS`].
    pub cancellations: u32,
    /// The value traded, summed over orderbooks at the clearing prices: `sum(sold * p_sell) /
    /// 2^32`, saturating.
    pub volume: u128,
    /// The value of the buckets past the smoothing band that did *not* trade, in the same units as
    /// `volume`. Zero means every such bucket executed in full. Prices only approximately clear
    /// the market, so where every book on a cycle is past the band the cycle cannot balance
    /// exactly and some of it goes unfilled; the circulation keeps that as small as possible.
    pub shortfall: u128,
}

/// What one orderbook trades: its levels fill from the most in-the-money down, so this is how many
/// levels filled in full and how much of the next one.
///
/// The remainder is kept as an integer floor and ceiling because it is a rational -- a value flow
/// divided by a price -- and [`fill`] needs to round the sold side up from it and the bought side
/// down, so that a book's offers together give up at least the flow and receive at most it.
#[sdk::contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct BookFill {
    /// Levels below this filled in full.
    pub full_below: u32,
    /// The remainder traded at level `full_below`, rounded down.
    pub lo: u128,
    /// The same remainder, rounded up.
    pub hi: u128,
    /// The total offered at level `full_below`, which the remainder is a share of.
    pub total: u128,
}

/// One offer's settlement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Fill {
    /// How much of the offer's amount it sold; the rest is refunded.
    pub sold: u128,
    /// How much of the buy asset it receives.
    pub bought: u128,
}

// ── The price grid ──────────────────────────────────────────────────────────

/// The limit-price grid: `octaves` doublings either side of a ratio of one, each divided into
/// `2^level_bits` geometric steps. Level `k` has the ratio `2^(k / 2^level_bits - octaves)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grid {
    pub octaves: u32,
    pub level_bits: u32,
}

impl Grid {
    /// Whether this is a grid the engine supports.
    pub const fn is_valid(self) -> bool {
        self.octaves >= 1
            && self.octaves <= MAX_OCTAVES
            && self.level_bits >= 1
            && self.level_bits <= MAX_LEVEL_BITS
    }

    /// How many levels the grid has: ratios from `2^-octaves` up to (not including)
    /// `2^octaves`.
    pub const fn levels(self) -> u32 {
        (2 * self.octaves) << self.level_bits
    }

    /// The limit ratio of level `k`, Q32.
    ///
    /// Exact to within a few parts in `2^62`: the fractional power of two is a product of the
    /// [`ROOTS_OF_TWO`] its bits select, in Q62 (each product of two Q62 values below `2^63`
    /// fits `u128`), and only then shifted to Q32.
    #[inline(never)]
    pub fn ratio(self, k: u32) -> Price {
        let frac = k & ((1 << self.level_bits) - 1);
        let whole = (k >> self.level_bits) as i32 - self.octaves as i32;
        let mut acc = 1u128 << 62;
        for j in 1..=self.level_bits {
            if (frac >> (self.level_bits - j)) & 1 == 1 {
                acc = (acc * ROOTS_OF_TWO[(j - 1) as usize] as u128) >> 62;
            }
        }
        let q32 = acc >> 30;
        let r = if whole >= 0 {
            q32 << (whole as u32)
        } else {
            q32 >> ((-whole) as u32)
        };
        r as Price
    }

    /// The lowest level whose ratio is at least `min_price`, or `None` if `min_price` is above
    /// the grid. A limit below the grid is raised to level zero.
    #[inline(never)]
    pub fn level_for(self, min_price: Price) -> Option<u32> {
        let (mut lo, mut hi) = (0, self.levels());
        if self.ratio(hi - 1) < min_price {
            return None;
        }
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if self.ratio(mid) >= min_price {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        Some(lo)
    }
}

/// Where the orderbook selling `sell` for `buy` sits in a per-book array.
pub const fn book(sell: usize, buy: usize) -> usize {
    sell * MAX_ASSETS + buy
}

// ── Fractions ──────────────────────────────────────────────────────────────
//
// The functions from here on are `#[inline(never)]`: the contract calls the engine from several
// entry points, and the chain caps a contract's code at 64 KiB, so each routine (and the `U256`
// arithmetic behind it) should exist in the artifact once rather than once per call site.

/// `p_sell / p_buy`, Q32: what a unit of `sell` fetches in `buy`.
#[inline(never)]
pub fn ratio(p_sell: Price, p_buy: Price) -> u128 {
    div((p_sell as u128) << 32, p_buy as u128)
}

/// What `traded` units of `sell` fetch in `buy`, rounded down; saturates.
#[inline(never)]
fn convert(traded: u128, p_sell: Price, p_buy: Price) -> u128 {
    mul_div(traded, p_sell as u128, p_buy as u128)
}

/// The fraction (Q32) of a bucket at `limit` that executes at these prices, for tâtonnement: none
/// while the ratio is at or below the limit, all of it once the ratio clears the smoothing band
/// above the limit, and proportionally in between.
#[inline(never)]
pub fn fill_fraction(p_sell: Price, p_buy: Price, limit: Price) -> u128 {
    fill_fraction_at(ratio(p_sell, p_buy), limit)
}

// [`fill_fraction`] at a ratio already computed (once per orderbook, in `aggregate`).
#[inline(never)]
fn fill_fraction_at(r: u128, limit: Price) -> u128 {
    let l = limit as u128;
    if r <= l {
        return 0;
    }
    let band = (l >> SMOOTH_SHIFT).max(1);
    let over = r - l;
    if over >= band {
        ONE
    } else {
        div(over * ONE, band)
    }
}

// `a * b / d`, rounded down; saturates if the quotient does not fit. A product that fits `u128`
// -- every one tâtonnement forms over a bucket below `2^72` -- stays in `u128`, where a shift
// stands in for the division by a power of two; the result is the same either way.
#[inline(never)]
fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    match a.checked_mul(b) {
        Some(product) if d.is_power_of_two() => product >> d.trailing_zeros(),
        Some(product) => div(product, d),
        None => checked_mul_div_u128(a, b, d).unwrap_or(u128::MAX),
    }
}

// `a * b / d`, rounded up; saturates if the quotient does not fit.
#[inline(never)]
fn mul_div_ceil(a: u128, b: u128, d: u128) -> u128 {
    let Some((q, r)) = U256::widening_mul(a, b).checked_div_rem(U256::from(d)) else {
        return u128::MAX;
    };
    let q = u128::try_from(q).unwrap_or(u128::MAX);
    if r.is_zero() { q } else { q.saturating_add(1) }
}

// `a / d` for a divisor that is not a power of two. RV32 has no 128-bit divide, so each division
// the compiler expands in place costs over a kilobyte of code; this is the one copy.
#[inline(never)]
fn div(a: u128, d: u128) -> u128 {
    a / d
}

// ── Prices ──────────────────────────────────────────────────────────────────

/// Scale the first `n` prices so the largest is [`PRICE_ANCHOR`], floor each at [`MIN_PRICE`], and
/// zero the rest. All-zero prices become all-equal.
#[inline(never)]
pub fn normalize(p: &mut Prices, n: usize) {
    let max = p[..n].iter().copied().max().unwrap_or(0);
    for a in 0..n {
        p[a] = if max == 0 {
            PRICE_ANCHOR
        } else {
            (mul_div(p[a] as u128, PRICE_ANCHOR as u128, max as u128) as Price).max(MIN_PRICE)
        };
    }
    for a in n..MAX_ASSETS {
        p[a] = 0;
    }
}

// Supply of and demand for each asset at prices `p`, in units of that asset: what the executing
// buckets sell, and what they buy with it.
#[inline(never)]
fn aggregate(buckets: &[Bucket], p: &Prices) -> ([u128; MAX_ASSETS], [u128; MAX_ASSETS]) {
    let mut supply = [0u128; MAX_ASSETS];
    let mut demand = [0u128; MAX_ASSETS];
    // A 128-bit division costs a few thousand gas on RV32, so a round takes one per asset -- the
    // reciprocal of its price, `2^79 / p`, which is at most `2^71` -- and a book's ratio is then a
    // multiply and a shift, within `2^-23` of [`ratio`]. Buckets come grouped by orderbook, so
    // even that is done once per book.
    let mut inverse = [0u128; MAX_ASSETS];
    let mut book = (u8::MAX, u8::MAX);
    let mut r = 0u128;
    for b in buckets {
        let (sell, buy) = (b.sell as usize, b.buy as usize);
        if book != (b.sell, b.buy) {
            book = (b.sell, b.buy);
            if inverse[buy] == 0 {
                inverse[buy] = div(1 << 79, p[buy] as u128);
            }
            r = (p[sell] as u128 * inverse[buy]) >> 47;
        }
        let phi = fill_fraction_at(r, b.limit);
        if phi == 0 {
            continue;
        }
        let sold = mul_div(b.amount, phi, ONE);
        supply[sell] = supply[sell].saturating_add(sold);
        // What that buys, through the book's ratio rather than a division per bucket: within
        // `2^-23` of `convert`, which settlement uses, and as deterministic.
        let bought = mul_div(sold, r, ONE);
        demand[buy] = demand[buy].saturating_add(bought);
    }
    (supply, demand)
}

/// How far `p` is from clearing the market: the value of the excess demand, summed over assets,
/// and the value supplied, to measure it against (both `amount * price / 2^32`, saturating).
#[inline(never)]
pub fn imbalance(buckets: &[Bucket], n: usize, p: &Prices) -> (u128, u128) {
    let (supply, demand) = aggregate(buckets, p);
    imbalance_of(&supply, &demand, n, p)
}

// `imbalance`, from an aggregate already taken at `p`.
#[inline(never)]
fn imbalance_of(
    supply: &[u128; MAX_ASSETS],
    demand: &[u128; MAX_ASSETS],
    n: usize,
    p: &Prices,
) -> (u128, u128) {
    let mut err = 0u128;
    let mut volume = 0u128;
    for a in 0..n {
        let p_a = p[a] as u128;
        err = err.saturating_add(mul_div(supply[a].abs_diff(demand[a]), p_a, ONE));
        volume = volume.saturating_add(mul_div(supply[a], p_a, ONE));
    }
    (err, volume)
}

// Within tolerance: the clearing error is a small fraction of the volume. Zero volume is never
// convergence -- the no-trade state clears trivially, and is worth nothing.
fn converged(err: u128, volume: u128) -> bool {
    volume > 0 && err.saturating_mul(TOLERANCE) <= volume
}

// Whether `(err_q, volume_q)` is a better state than `(err_p, volume_p)`: a smaller clearing error
// *relative to volume*, with zero volume the worst state of all. Comparing the relative error is
// what keeps a step from "improving" by pricing every offer out of the market.
#[inline(never)]
fn better(err_q: u128, volume_q: u128, err_p: u128, volume_p: u128) -> bool {
    if volume_q == 0 {
        return false;
    }
    if volume_p == 0 {
        return true;
    }
    U256::widening_mul(err_q, volume_p) < U256::widening_mul(err_p, volume_q)
}

/// Find approximate market-clearing prices for the batch.
///
/// Walrasian tâtonnement: start from equal prices, and in each round raise the price of every asset
/// in excess demand and lower the price of every asset in excess supply. A market of limit offers
/// is one of gross substitutes -- raising an asset's price only ever adds to its supply and takes
/// from its demand -- and in such a market a price that moves with the sign of its excess demand
/// closes in on the equilibrium, but no *observable* quantity does so monotonically: a book whose
/// asks are all out of the money adds the same value of excess demand whatever the price, until
/// the price reaches them. So no step is ever discarded. Instead each asset keeps its own step
/// (as in Rprop): a direction that persists grows it, so that a price a long way from its asks
/// gets there in a few rounds, and a reversal halves it, which is what refines the answer. The
/// step is scaled by the relative imbalance, `(d - s) / (d + s)`, so that moves shrink as the
/// market balances. The prices returned are the best seen, by clearing error relative to the
/// volume traded.
///
/// Stops when the error is within [`TOLERANCE`] of the volume, when every step has shrunk to
/// nothing, or after `max_rounds` rounds; each round costs one pass over the buckets.
///
/// If nothing executes at equal prices, nothing can execute at any: every bucket then wants more
/// than one of its buy asset per unit sold, and a trade is a cycle of sales whose ratios multiply
/// to one. Such a batch returns at once.
///
/// Deterministic: a pure function of the batch, so anyone may run it and everyone gets the same
/// prices. Returns the prices and the number of rounds run.
#[inline(never)]
pub fn tatonnement(buckets: &[Bucket], n: usize, max_rounds: u32) -> (Prices, u32) {
    let mut p = [0 as Price; MAX_ASSETS];
    normalize(&mut p, n);
    let (mut supply, mut demand) = aggregate(buckets, &p);
    let (mut err, mut volume) = imbalance_of(&supply, &demand, n, &p);
    if volume == 0 {
        return (p, 0);
    }
    let (mut best, mut best_err, mut best_volume) = (p, err, volume);
    let mut step = [STEP_INIT; MAX_ASSETS];
    let mut rising = [None::<bool>; MAX_ASSETS];
    let mut rounds = 0;

    while rounds < max_rounds && !converged(err, volume) && step[..n].iter().any(|&s| s >= STEP_MIN)
    {
        rounds += 1;

        for a in 0..n {
            let (s, d) = (supply[a], demand[a]);
            if s == d {
                continue;
            }
            let up = d > s;
            step[a] = match rising[a] {
                Some(was_up) if was_up == up => (step[a] + step[a] / 2).min(STEP_MAX),
                Some(_) => step[a] / 2,
                None => step[a],
            };
            rising[a] = Some(up);
            // The move: `step` times the relative imbalance, which lies in (0, 1], as a factor
            // symmetric in log space.
            let factor = ONE + mul_div(step[a], s.abs_diff(d), s.saturating_add(d));
            p[a] = if up {
                mul_div(p[a] as u128, factor, ONE)
            } else {
                mul_div(p[a] as u128, ONE, factor)
            } as Price;
        }
        normalize(&mut p, n);

        (supply, demand) = aggregate(buckets, &p);
        (err, volume) = imbalance_of(&supply, &demand, n, &p);
        if better(err, volume, best_err, best_volume) {
            (best, best_err, best_volume) = (p, err, volume);
        }
    }

    (best, rounds)
}

// ── The circulation ─────────────────────────────────────────────────────────
//
// SPEEDEX's linear program, without a fee, is a circulation problem. Each orderbook is an edge
// from its sell asset to its buy asset carrying *value* -- amount sold times the sell price --
// and the constraint that no asset is bought in greater value than it is sold sums to zero over
// the assets, so it holds with equality everywhere: value in equals value out at every asset. An
// edge's capacity is the value of its buckets in the money, and the part of it belonging to
// buckets past the smoothing band ought to be used before any marginal bucket trades. Maximizing
// volume under that priority is a minimum-cost circulation with two arcs per edge, which has an
// integral solution, found here by cycle cancelling in `U256` (a bucket of up to 2^127 at a price
// of up to 2^56 is a value of up to 2^183) with no rounding anywhere.

// An orderbook as an edge of the value graph: what must trade if it can, what may, and what does.
struct Edge {
    sell: usize,
    buy: usize,
    /// The value of the buckets past the smoothing band.
    must: U256,
    /// The value of the buckets inside it.
    may: U256,
    /// Flow on the `must` part, then on the `may` part.
    flow_must: U256,
    flow_may: U256,
}

// The edges of a batch at prices `p`: one per orderbook with anything in the money.
#[inline(never)]
fn edges(buckets: &[Bucket], n: usize, p: &Prices) -> Vec<Edge> {
    // Sized once: the guest's allocator never frees, so a vector that grew by doubling would
    // leave its outgrown copies behind.
    let mut out: Vec<Edge> = Vec::with_capacity(n * (n - 1));
    for b in buckets {
        let (sell, buy) = (b.sell as usize, b.buy as usize);
        let r = ratio(p[sell], p[buy]);
        let l = b.limit as u128;
        if r <= l {
            continue;
        }
        let value = U256::from(b.amount) * U256::from(p[sell] as u128);
        let past_band = r >= l + (l >> SMOOTH_SHIFT).max(1);
        let e = match out.iter_mut().find(|e| e.sell == sell && e.buy == buy) {
            Some(e) => e,
            None => {
                out.push(Edge {
                    sell,
                    buy,
                    must: U256::ZERO,
                    may: U256::ZERO,
                    flow_must: U256::ZERO,
                    flow_may: U256::ZERO,
                });
                out.last_mut().unwrap()
            }
        };
        if past_band {
            e.must += value;
        } else {
            e.may += value;
        }
    }
    out
}

// What a unit of flow on a `must` arc is worth against a unit on a `may` arc. A cancelled cycle
// has at most `4 * MAX_BOOKS` arcs, so no cycle can profitably trade `must` flow for `may` flow:
// the solution fills the buckets past the band as fully as any circulation can before any
// marginal bucket trades at all.
const PRIORITY: i32 = 4 * MAX_BOOKS as i32 + 1;

// The residual arcs of edge `e`, four to an edge: forward and backward on each part. Each is
// `(from, to, capacity, cost per unit)`.
fn residual(edges: &[Edge], i: usize) -> (usize, usize, U256, i32) {
    let e = &edges[i / 4];
    match i % 4 {
        0 => (e.sell, e.buy, e.must - e.flow_must, -PRIORITY),
        1 => (e.buy, e.sell, e.flow_must, PRIORITY),
        2 => (e.sell, e.buy, e.may - e.flow_may, -1),
        _ => (e.buy, e.sell, e.flow_may, 1),
    }
}

// Find the maximum-priority, then maximum-volume circulation by cycle cancelling, starting from
// no flow at all (which is a circulation), and return how many cycles it took.
//
// Bellman-Ford over the residual arcs finds a cycle of negative total cost -- one that gains more
// than it gives up -- and the bottleneck of flow is pushed around it. When no such cycle remains
// the circulation is optimal. Every push is an integer step that strictly improves the objective,
// so the loop terminates; [`MAX_CANCELLATIONS`] bounds it anyway, since the flow is a valid
// circulation at every step and stopping early only costs volume.
#[inline(never)]
fn circulate(edges: &mut [Edge], n: usize) -> u32 {
    let arcs = 4 * edges.len();
    for cancelled in 0..MAX_CANCELLATIONS {
        let mut dist = [0i32; MAX_ASSETS];
        let mut via = [usize::MAX; MAX_ASSETS];
        let mut last_relaxed = usize::MAX;
        for _ in 0..n {
            last_relaxed = usize::MAX;
            for i in 0..arcs {
                let (from, to, cap, cost) = residual(edges, i);
                if !cap.is_zero() && dist[from] + cost < dist[to] {
                    dist[to] = dist[from] + cost;
                    via[to] = i;
                    last_relaxed = to;
                }
            }
            if last_relaxed == usize::MAX {
                return cancelled;
            }
        }

        // A relaxation on the n-th pass means a negative cycle; walking back n steps lands on it.
        let mut v = last_relaxed;
        for _ in 0..n {
            v = residual(edges, via[v]).0;
        }
        let start = v;
        let mut bottleneck = U256::MAX;
        loop {
            let (from, _, cap, _) = residual(edges, via[v]);
            bottleneck = bottleneck.min(cap);
            v = from;
            if v == start {
                break;
            }
        }
        let mut v = start;
        loop {
            let i = via[v];
            let from = residual(edges, i).0;
            let e = &mut edges[i / 4];
            match i % 4 {
                0 => e.flow_must += bottleneck,
                1 => e.flow_must -= bottleneck,
                2 => e.flow_may += bottleneck,
                _ => e.flow_may -= bottleneck,
            }
            v = from;
            if v == start {
                break;
            }
        }
    }
    MAX_CANCELLATIONS
}

// ── Putting it together ─────────────────────────────────────────────────────

/// Clear a batch: prices by [`tatonnement`], then the trades as a maximum circulation, buckets
/// past the smoothing band first. `buckets` must be grouped by orderbook and in level order
/// within each.
///
/// Returns the clearing and, for every orderbook that trades, its index (see [`book`]) and
/// [`BookFill`]. A book absent from the list trades nothing.
#[inline(never)]
pub fn clear(buckets: &[Bucket], n: usize, max_rounds: u32) -> (Clearing, Vec<(usize, BookFill)>) {
    let (prices, rounds) = tatonnement(buckets, n, max_rounds);
    trades(buckets, n, &prices, rounds)
}

/// The trade half of [`clear`]: the circulation at `prices`, and what it fills of each orderbook.
/// `rounds` is only recorded in the [`Clearing`].
#[inline(never)]
pub fn trades(
    buckets: &[Bucket],
    n: usize,
    prices: &Prices,
    rounds: u32,
) -> (Clearing, Vec<(usize, BookFill)>) {
    let mut es = edges(buckets, n, prices);
    let cancellations = circulate(&mut es, n);

    let mut volume = U256::ZERO;
    let mut fills = Vec::with_capacity(es.len());
    let mut shortfall = U256::ZERO;
    for e in &es {
        shortfall += e.must - e.flow_must;
        let flow = e.flow_must + e.flow_may;
        if flow.is_zero() {
            continue;
        }
        volume += flow;

        // The amount of the sell asset this flow is worth, as a rational: fill levels in full
        // from the bottom while they fit, and the next one takes the remainder.
        let price = U256::from(prices[e.sell] as u128);
        let (mut whole, rem) = flow.checked_div_rem(price).unwrap();
        let mut fill = BookFill::default();
        for b in buckets
            .iter()
            .filter(|b| (b.sell as usize, b.buy as usize) == (e.sell, e.buy))
        {
            let amount = U256::from(b.amount);
            if whole > amount || (whole == amount && rem.is_zero()) {
                whole -= amount;
                fill.full_below = b.level + 1;
                continue;
            }
            // `whole + rem / price` of this bucket, which is less than all of it.
            fill.full_below = b.level;
            fill.total = b.amount;
            fill.lo = u128::try_from(whole).unwrap();
            fill.hi = if rem.is_zero() { fill.lo } else { fill.lo + 1 };
            break;
        }
        fills.push((book(e.sell, e.buy), fill));
    }

    let clearing = Clearing {
        prices: *prices,
        rounds,
        cancellations,
        volume: u128::try_from(volume >> 32u32).unwrap_or(u128::MAX),
        shortfall: u128::try_from(shortfall >> 32u32).unwrap_or(u128::MAX),
    };
    (clearing, fills)
}

/// Settle one offer of `amount` at grid `level`, under its orderbook's [`BookFill`], selling at
/// `p_sell` for `p_buy`.
///
/// A level below `full_below` sold everything. The marginal level sold its share of the
/// remainder, rounded *up* (capped at the amount), and is paid its share of the remainder rounded
/// *down*, converted at the clearing ratio and rounded down again. Every rounding favors the
/// exchange by less than a unit. Summed over a book's offers, what they give up is at least the
/// value that flowed out of the sell asset on that book and what they receive is at most the value
/// that flowed in to the buy asset -- and the flows are a circulation, so the exchange can pay
/// every offer of every batch it cleared, in any order, without ever having seen them together.
///
/// The roundings are also the one way an effective price can fall short of a limit: by under a
/// unit of the buy asset, on a sale that may be rounded up by under a unit of the sell asset.
/// Relative to an offer of [`MIN_AMOUNT`] that is under a few parts in `2^15`.
#[inline(never)]
pub fn fill(amount: u128, level: u32, book: &BookFill, p_sell: Price, p_buy: Price) -> Fill {
    if level < book.full_below {
        return Fill {
            sold: amount,
            bought: convert(amount, p_sell, p_buy),
        };
    }
    if level > book.full_below || book.total == 0 || book.hi == 0 {
        return Fill::default();
    }
    let traded = mul_div(amount, book.lo, book.total);
    Fill {
        sold: mul_div_ceil(amount, book.hi, book.total).min(amount),
        bought: convert(traded, p_sell, p_buy),
    }
}
