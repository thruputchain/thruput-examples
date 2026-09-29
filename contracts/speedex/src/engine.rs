//! The clearing engine: SPEEDEX's arithmetic, with no storage behind it.
//!
//! A batch is described to the engine as a list of [`Bucket`]s -- for each orderbook (a `sell`
//! asset and a `buy` asset) and each price level on the [grid](level_ratio), the total amount
//! offered at that level. The engine never sees individual offers: it computes one price per asset
//! by [tâtonnement](tatonnement) over that aggregate supply and demand, then per-asset [trims and
//! haircuts](feasibility) that make the trades at those prices exactly feasible. [`fill`] then tells any single offer, from
//! those few numbers alone, what it sold and what it bought -- which is what lets the contract
//! settle offers one at a time, in any order, in parallel.
//!
//! # Fixed point
//!
//! Every fraction here is Q32: an integer whose value is `x / 2^32`, with [`ONE`] as one. Prices are
//! Q32 too, and only their ratios mean anything: `p_sell / p_buy` is how many units of the buy
//! asset one unit of the sell asset is worth. [`normalize`] pins the largest price of a batch to
//! [`PRICE_ANCHOR`] and floors the rest at [`MIN_PRICE`], which is what keeps every intermediate
//! product within `u128` for offers below [`MAX_AMOUNT`], and within `U256` for the aggregates,
//! whose buckets may total anything up to `i128::MAX`.

#![allow(clippy::needless_range_loop)]

use alloc::vec::Vec;
use sdk::{U256, checked_mul_div_u128};

/// The most assets one exchange can value. Arrays are sized by this; a batch uses the first `n`.
pub const MAX_ASSETS: usize = 8;

/// A valuation, Q32.
pub type Price = u64;
/// One price per asset; entries at or past the exchange's asset count are zero.
pub type Prices = [Price; MAX_ASSETS];
/// A fraction in `[0, ONE]`, Q32.
pub type Fraction = u64;
/// The buyer-side trim per asset; see [`feasibility`].
pub type Trims = [Fraction; MAX_ASSETS];
/// The receipt haircut per asset, between `FEE_KEEP / FEE_DEN` and one; see [`feasibility`].
pub type Haircuts = [Fraction; MAX_ASSETS];

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
/// is exact for any total up to `i128::MAX`; see [`fill`] for where the per-offer bound matters.
pub const MAX_AMOUNT: u128 = 1 << 80;
/// Offers must be at least this. Each rounding in [`fill`] costs the seller less than a unit, so the
/// smallest offer bounds how far an effective price can fall short of its limit: for an offer of
/// this size, under two parts in `2^15`.
pub const MIN_AMOUNT: u128 = 1 << 16;

/// Price levels per octave (doubling) of the grid.
pub const LEVELS_PER_OCTAVE: u32 = 8;
/// The widest grid: limit ratios from `2^-8` to just under `2^8`.
pub const MAX_OCTAVES: u32 = 8;
/// The most levels a grid can have, and so the most buckets one orderbook can hold.
pub const MAX_LEVELS: u32 = 2 * MAX_OCTAVES * LEVELS_PER_OCTAVE;

// 2^(i/8) for i in 0..8, Q32.
const EIGHTH_OCTAVE: [u64; 8] = [
    4_294_967_296,
    4_683_695_048,
    5_107_605_667,
    5_569_883_475,
    6_074_001_000,
    6_623_745_059,
    7_223_245_206,
    7_877_004_752,
];

/// Width of the smoothing band as a fraction of the level: an offer at level `L` executes fully
/// once the ratio reaches `L * (1 + 2^-SMOOTH_SHIFT)`, and proportionally in between. The band is
/// what gives tâtonnement a gradient to follow instead of a step.
pub const SMOOTH_SHIFT: u32 = 6;
/// The exchange's fee, as a denominator: a buyer receives `FEE_KEEP / FEE_DEN` of what its sale is
/// worth at the clearing ratio, and the exchange keeps the rest.
///
/// This is SPEEDEX's fee parameter, and it does more than pay the exchange. At exactly clearing
/// prices the value bought of every asset equals the value sold (Walras' law), so requiring the
/// sold amount to cover the bought amount is a knife edge that any rounding falls off. The fee
/// turns it into a margin, which is what lets [`feasibility`] settle in a round or two rather than
/// chasing rounding around a cycle of assets.
pub const FEE_DEN: u128 = 1 << 10;
/// See [`FEE_DEN`].
pub const FEE_KEEP: u128 = FEE_DEN - 1;
/// Tâtonnement is not done while any asset is over-demanded by more than one part in this: the
/// residual [`feasibility`] then absorbs as a haircut stays well inside the fee's margin.
const OVER_DEMAND_DEN: u128 = 2 * FEE_DEN;
/// The most price-update rounds tâtonnement will run.
pub const MAX_ROUNDS: u32 = 64;
/// How many rounds [`feasibility`] trims before it settles the rest with haircuts.
pub const TRIM_ROUNDS: u32 = 16;
// Clearing error below one part in this of the traded volume ends tâtonnement early.
const TOLERANCE: u128 = 1000;
// Step-size control, Q32.
const STEP_INIT: u128 = ONE / 8;
const STEP_MAX: u128 = ONE / 2;
const STEP_MIN: u128 = ONE >> 12;

/// The total amount offered at one price level of one orderbook.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bucket {
    pub sell: usize,
    pub buy: usize,
    /// The level's limit ratio (see [`level_ratio`]): the least `p_sell / p_buy` at which these
    /// offers execute.
    pub limit: Price,
    pub amount: u128,
}

/// What clearing a batch decided, and all that settling any of its offers needs.
#[sdk::contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clearing {
    /// The valuation prices, normalized.
    pub prices: Prices,
    /// The buyer-side trim per asset, Q32; see [`feasibility`].
    pub trims: Trims,
    /// The receipt haircut per asset, Q32; see [`feasibility`].
    pub haircuts: Haircuts,
    /// How many price-update rounds tâtonnement ran.
    pub rounds: u32,
    /// The value traded, summed over assets at the clearing prices: `sum(sold_a * p_a) / 2^32`.
    pub volume: u128,
    /// What the exchange is sure to keep of each asset once every offer has settled: the fee, less
    /// than what rounding adds on top. See [`fill`].
    pub surplus: [u128; MAX_ASSETS],
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

/// How many levels a grid of `octaves` has: ratios from `2^-octaves` up to (not including)
/// `2^octaves`, [`LEVELS_PER_OCTAVE`] to the doubling.
pub const fn levels(octaves: u32) -> u32 {
    2 * octaves * LEVELS_PER_OCTAVE
}

/// The limit ratio of level `k` on a grid of `octaves`: `2^(k / 8 - octaves)`, Q32.
#[inline(never)]
pub fn level_ratio(k: u32, octaves: u32) -> Price {
    let step = EIGHTH_OCTAVE[(k % LEVELS_PER_OCTAVE) as usize] as u128;
    ((step << (k / LEVELS_PER_OCTAVE)) >> octaves) as Price
}

/// The lowest level whose ratio is at least `min_price`, or `None` if `min_price` is above the
/// grid. A limit below the grid is raised to level zero.
#[inline(never)]
pub fn level_for(min_price: Price, octaves: u32) -> Option<u32> {
    (0..levels(octaves)).find(|&k| level_ratio(k, octaves) >= min_price)
}

// ── Fractions ──────────────────────────────────────────────────────────────
//
// The functions from here on are `#[inline(never)]`: the contract calls the engine from several
// entry points, and the chain caps a contract's code at 64 KiB, so each routine (and the `U256`
// arithmetic behind it) should exist in the artifact once rather than once per call site.─

/// The least a unit of `sell` can fetch in `buy` at these prices, Q32: the ratio less the fee, less
/// the most a receipt haircut may take (another fee's worth). An offer executes only if this beats
/// its limit, which is what makes the limit hold whatever [`feasibility`] then does.
#[inline(never)]
pub fn effective_ratio(p_sell: Price, p_buy: Price) -> u128 {
    div((p_sell as u128) << 32, p_buy as u128) * FEE_KEEP / FEE_DEN * FEE_KEEP / FEE_DEN
}

/// What `traded` units of `sell` fetch in `buy` after the fee, rounded down.
#[inline(never)]
fn convert(traded: u128, p_sell: Price, p_buy: Price) -> u128 {
    let bought = U256::from(traded) * U256::from(p_sell as u128 * FEE_KEEP)
        / U256::from(p_buy as u128 * FEE_DEN);
    u128::try_from(bought).unwrap_or(u128::MAX)
}

/// The fraction (Q32) of a bucket at `limit` that executes at these prices: none while the
/// effective ratio is at or below the limit, all of it once the ratio clears the smoothing band
/// above the limit, and proportionally in between.
#[inline(never)]
pub fn fill_fraction(p_sell: Price, p_buy: Price, limit: Price) -> u128 {
    let r = effective_ratio(p_sell, p_buy);
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

/// The share (Q32) of a bucket's amount that actually trades: its fill fraction at the prices,
/// scaled by its buy asset's trim. One rounding, shared by every path that settles or sums.
#[inline(never)]
fn share(fraction: u128, trim: Fraction) -> u128 {
    fraction * trim as u128 / ONE
}

// `a * b / d`, rounded down; saturates if the quotient does not fit.
#[inline(never)]
fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    checked_mul_div_u128(a, b, d).unwrap_or(u128::MAX)
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
fn aggregate(buckets: &[Bucket], n: usize, p: &Prices) -> ([u128; MAX_ASSETS], [u128; MAX_ASSETS]) {
    let mut supply = [0u128; MAX_ASSETS];
    let mut demand = [0u128; MAX_ASSETS];
    for b in buckets {
        let phi = fill_fraction(p[b.sell], p[b.buy], b.limit);
        if phi == 0 {
            continue;
        }
        // Buckets may exceed 2^96, so the product needs the wide multiply.
        let sold = mul_div(b.amount, phi, ONE);
        supply[b.sell] = supply[b.sell].saturating_add(sold);
        let bought = convert(sold, p[b.sell], p[b.buy]);
        demand[b.buy] = demand[b.buy].saturating_add(bought);
    }
    let _ = n;
    (supply, demand)
}

// How far `p` is from clearing the market.
#[derive(Clone, Copy)]
struct Imbalance {
    // The value of the excess demand, summed over assets.
    err: u128,
    // The value supplied, to measure `err` against.
    volume: u128,
    // Whether any asset is demanded beyond its supply by more than one part in `OVER_DEMAND_DEN`.
    over_demanded: bool,
}

#[inline(never)]
fn imbalance(buckets: &[Bucket], n: usize, p: &Prices) -> Imbalance {
    let (supply, demand) = aggregate(buckets, n, p);
    let mut err = 0u128;
    let mut volume = 0u128;
    let mut over_demanded = false;
    for a in 0..n {
        let p_a = p[a] as u128;
        err = err.saturating_add(mul_div(supply[a].abs_diff(demand[a]), p_a, ONE));
        volume = volume.saturating_add(mul_div(supply[a], p_a, ONE));
        if demand[a] > supply[a]
            && (demand[a] - supply[a]).saturating_mul(OVER_DEMAND_DEN) > supply[a]
        {
            over_demanded = true;
        }
    }
    Imbalance {
        err,
        volume,
        over_demanded,
    }
}

// Within tolerance: the clearing error is a small fraction of the volume, and no asset is
// over-demanded by more than a haircut can absorb. Zero volume is never convergence -- the no-trade
// state clears trivially, and is worth nothing.
fn converged(i: &Imbalance) -> bool {
    i.volume > 0 && i.err.saturating_mul(TOLERANCE) <= i.volume && !i.over_demanded
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
/// in excess demand and lower the price of every asset in excess supply, in proportion to the
/// imbalance. The step size grows while the clearing error (relative to the volume traded) keeps
/// falling and halves when a step would make it worse (that step is discarded). Stops when the
/// error is within tolerance of the volume, when the step has shrunk to nothing, or after
/// [`MAX_ROUNDS`].
///
/// If nothing executes at equal prices, nothing can execute at any: every bucket then wants more
/// than one of its buy asset per unit sold, and a trade is a cycle of sales whose ratios multiply
/// to one. Such a batch returns at once.
///
/// Deterministic: a pure function of the batch, so anyone may run it and everyone gets the same
/// prices. Returns the prices and the number of rounds run.
#[inline(never)]
pub fn tatonnement(buckets: &[Bucket], n: usize) -> (Prices, u32) {
    let mut p = [0 as Price; MAX_ASSETS];
    normalize(&mut p, n);

    let mut at = imbalance(buckets, n, &p);
    if at.volume == 0 {
        return (p, 0);
    }
    let mut step = STEP_INIT;
    let mut rounds = 0;

    while rounds < MAX_ROUNDS && step >= STEP_MIN && !converged(&at) {
        rounds += 1;

        let (supply, demand) = aggregate(buckets, n, &p);
        let mut q = p;
        for a in 0..n {
            let (s, d) = (supply[a], demand[a]);
            if s == d {
                continue;
            }
            // Move by `step` times the relative imbalance, (d - s) / (d + s), which lies in (-1, 1).
            let relative = mul_div(p[a] as u128, s.abs_diff(d), s.saturating_add(d));
            let adj = mul_div(relative, step, ONE) as Price;
            q[a] = if d > s {
                p[a].saturating_add(adj)
            } else {
                p[a].saturating_sub(adj)
            };
        }
        normalize(&mut q, n);

        let to = imbalance(buckets, n, &q);
        if better(to.err, to.volume, at.err, at.volume) {
            p = q;
            at = to;
            step = (step + step / 2).min(STEP_MAX);
        } else {
            step /= 2;
        }
    }

    (p, rounds)
}

// ── Feasibility ─────────────────────────────────────────────────────────────

// The value flows at these prices and trims, exactly.
//
// For each asset `a`, `supply[a]` and `demand[a]` are rationals over the common denominator
// `2^32 * p_a * FEE_DEN`: what the buckets selling `a` give up, and what the buckets buying `a` are
// owed after the fee. Comparing them is exact, so the check below is free of rounding noise; the
// only rounding is per offer, in `fill`, and it always goes the exchange's way. `sold[a]` is the
// integer part of the supply, for the volume.
//
// Magnitudes: a term is at most `2^127 * 2^32 * 2^56 * 2^10 = 2^225`, and an asset has under 2^10
// buckets on either side, so a sum stays under 2^235.
struct Flows {
    supply: [U256; MAX_ASSETS],
    demand: [U256; MAX_ASSETS],
    sold: [u128; MAX_ASSETS],
}

#[inline(never)]
fn flows(buckets: &[Bucket], p: &Prices, trims: &Trims) -> Flows {
    let mut f = Flows {
        supply: [U256::ZERO; MAX_ASSETS],
        demand: [U256::ZERO; MAX_ASSETS],
        sold: [0u128; MAX_ASSETS],
    };
    for b in buckets {
        let s = share(fill_fraction(p[b.sell], p[b.buy], b.limit), trims[b.buy]);
        if s == 0 {
            continue;
        }
        let traded = U256::from(b.amount) * U256::from(s);
        f.sold[b.sell] = f.sold[b.sell].saturating_add(mul_div(b.amount, s, ONE));
        f.supply[b.sell] += traded * U256::from(p[b.sell] as u128 * FEE_DEN);
        f.demand[b.buy] += traded * U256::from(p[b.sell] as u128 * FEE_KEEP);
    }
    f
}

// `num / den` as a Q32 fraction, rounded down, capped at one. When `num << 32` would not fit, both
// are scaled down first, the divisor rounded up, so the result is never more than the exact value:
// the callers use it to shrink a flow to fit a bound, and shrinking a little too much is safe.
#[inline(never)]
fn scale_q32(num: U256, den: U256) -> Fraction {
    let excess = num.bit_len().saturating_sub(U256::BITS - 33);
    let (n, d) = if excess == 0 {
        (num, den)
    } else {
        (num >> excess, (den >> excess) + U256::ONE)
    };
    if d.is_zero() {
        return ONE as Fraction;
    }
    let q = (n << 32u32) / d;
    u128::try_from(q).unwrap_or(u128::MAX).min(ONE) as Fraction
}

/// Make the trades at `prices` exactly feasible: a buyer-side trim and a receipt haircut per asset.
///
/// Tâtonnement only clears the market approximately, so at its prices an asset may be owed in
/// greater quantity than it is sold. SPEEDEX resolves this with a linear program; this engine uses
/// two simpler levers, one after the other.
///
/// *Trims* first: every buyer of an over-demanded asset is scaled back by the same fraction, and
/// the check is repeated, since a scaled-back buyer also sells less of its own asset. Trims only
/// decrease, and while the fee's slack outweighs the price error this settles in a round or two.
/// Where it does not -- when the excess circulates around the assets and every trim shrinks a
/// little each round -- iterating further would only shrink the batch, so after [`TRIM_ROUNDS`]
/// the residual goes to the second lever.
///
/// *Haircuts* then: buyers of an asset still over-demanded receive `supply / demand` of what they
/// are owed. A haircut cannot cascade, because it changes what a buyer receives and not what it
/// sells, so this makes every asset exactly feasible at once. It does lower the buyer's effective
/// price, so a haircut is allowed at most one fee's worth -- which [`effective_ratio`] already held
/// back when deciding what executes, so every limit still holds -- and an asset that would need
/// more has its buyers zeroed instead, which is the one thing that may take a few more rounds.
///
/// All checks are exact: the supply and demand of each asset are compared as rationals, so the
/// only rounding is per offer, in [`fill`], and it always goes the exchange's way.
#[inline(never)]
pub fn feasibility(buckets: &[Bucket], n: usize, prices: &Prices) -> (Trims, Haircuts) {
    let mut trims = [0 as Fraction; MAX_ASSETS];
    trims[..n].fill(ONE as Fraction);
    let mut haircuts = [0 as Fraction; MAX_ASSETS];

    for round in 0.. {
        let f = flows(buckets, prices, &trims);
        let mut again = false;
        for a in 0..n {
            haircuts[a] = ONE as Fraction;
            if f.demand[a] <= f.supply[a] {
                continue;
            }
            if round < TRIM_ROUNDS {
                let by = scale_q32(f.supply[a], f.demand[a]) as u128;
                trims[a] = (trims[a] as u128 * by / ONE) as Fraction;
                again = true;
            } else if f.demand[a] * U256::from(FEE_KEEP) > f.supply[a] * U256::from(FEE_DEN) {
                // More than a haircut may take: these buyers are out.
                trims[a] = 0;
                again = true;
            } else {
                haircuts[a] = scale_q32(f.supply[a], f.demand[a]);
            }
        }
        if !again {
            break;
        }
    }

    (trims, haircuts)
}

// ── Putting it together ─────────────────────────────────────────────────────

/// Clear a batch: prices by [`tatonnement`], then [`feasibility`].
#[inline(never)]
pub fn clear(buckets: &[Bucket], n: usize) -> Clearing {
    let (prices, rounds) = tatonnement(buckets, n);
    let (trims, haircuts) = feasibility(buckets, n, &prices);

    let f = flows(buckets, &prices, &trims);
    let mut volume = 0u128;
    let mut surplus = [0u128; MAX_ASSETS];
    for a in 0..n {
        volume = volume.saturating_add(mul_div(f.sold[a], prices[a] as u128, ONE));
        // What the buyers are owed after the haircut, rounded up, over the flows' denominator:
        // split the demand at 2^32 so neither product can outgrow `U256`.
        let h = U256::from(haircuts[a] as u128);
        let one = U256::from(ONE);
        let (q, r) = (f.demand[a] / one, f.demand[a] % one);
        let owed =
            q * h + U256::from((u128::try_from(r).unwrap() * haircuts[a] as u128).div_ceil(ONE));
        let kept = f.supply[a].checked_sub(owed).unwrap_or(U256::ZERO)
            / U256::from(ONE * prices[a] as u128 * FEE_DEN);
        surplus[a] = u128::try_from(kept).unwrap_or(u128::MAX);
    }

    Clearing {
        prices,
        trims,
        haircuts,
        rounds,
        volume,
        surplus,
    }
}

/// Settle one offer of `amount`, selling `sell` for `buy` at `limit`, under a [`Clearing`].
///
/// The share that trades is the bucket's fill fraction times the buy asset's trim. What the offer
/// gives up is that share of its amount rounded *up* (capped at the amount); what it receives is
/// the share rounded *down*, converted at the clearing ratio less the fee, less the buy asset's
/// haircut, rounding down at each step. Every rounding favors the exchange by less than a unit.
/// Summed over a bucket's offers, what they give up is at least the bucket's exact supply and what
/// they receive is at most its exact demand -- the quantities [`feasibility`] compared -- so the
/// exchange can pay every offer of every batch it cleared, in any order, without ever having seen
/// them together.
///
/// The roundings are also the one way an effective price can fall short of a limit: by under a unit
/// of the buy asset, on a sale that may be rounded up by under a unit of the sell asset. Relative to
/// an offer of [`MIN_AMOUNT`] that is under two parts in `2^15`; the fee margin in
/// [`effective_ratio`] does not cover it, since a rate may beat a limit by as little as one Q32
/// unit.
#[inline(never)]
pub fn fill(amount: u128, sell: usize, buy: usize, limit: Price, clearing: &Clearing) -> Fill {
    let (p_sell, p_buy) = (clearing.prices[sell], clearing.prices[buy]);
    let s = share(fill_fraction(p_sell, p_buy, limit), clearing.trims[buy]);
    if s == 0 {
        return Fill::default();
    }
    let traded = amount * s / ONE;
    let owed = convert(traded, p_sell, p_buy);
    Fill {
        sold: (amount * s).div_ceil(ONE).min(amount),
        bought: mul_div(owed, clearing.haircuts[buy] as u128, ONE),
    }
}

/// Gather a batch's non-empty buckets from a histogram, `f(sell, buy, level) -> amount`.
#[inline(never)]
pub fn buckets(
    n: usize,
    octaves: u32,
    mut f: impl FnMut(usize, usize, u32) -> u128,
) -> Vec<Bucket> {
    let mut out = Vec::new();
    for sell in 0..n {
        for buy in 0..n {
            if sell == buy {
                continue;
            }
            for level in 0..levels(octaves) {
                let amount = f(sell, buy, level);
                if amount > 0 {
                    out.push(Bucket {
                        sell,
                        buy,
                        limit: level_ratio(level, octaves),
                        amount,
                    });
                }
            }
        }
    }
    out
}
