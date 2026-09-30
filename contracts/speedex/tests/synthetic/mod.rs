//! Synthetic batches for the benchmarks: offers scattered around a hidden set of true valuations,
//! so that a clearing exists and its quality can be judged against the truth.
//!
//! Shared by `tests/quality.rs` (the engine, natively) and `tests/testkit_gas.rs` (the contract,
//! on a devnode).

#![allow(dead_code)]

use speedex::engine::{self, Bucket, Grid, MIN_AMOUNT, PRICE_ONE, Price};

/// One generated offer, before aggregation.
#[derive(Clone, Copy, Debug)]
pub struct Offer {
    pub sell: usize,
    pub buy: usize,
    /// The grid level its limit rounds up to.
    pub level: u32,
    /// The limit as the contract takes it, Q32.
    pub min_price: Price,
    pub amount: u128,
}

/// A synthetic batch: its offers, the buckets they aggregate to (in the order the contract reads
/// them: by orderbook, then level), and the true log2 valuation of each asset the limits were
/// scattered around.
pub struct Batch {
    pub n: usize,
    pub grid: Grid,
    pub offers: Vec<Offer>,
    pub buckets: Vec<Bucket>,
    pub truth: Vec<f64>,
}

/// A small deterministic generator (PCG-style output of an LCG), so every run is reproducible
/// from its seed.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut r = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) ^ 0xD1B54A32D192ED03);
        r.next();
        r
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let x = self.0;
        (x ^ (x >> 29)).rotate_right((x >> 59) as u32 + 5)
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Standard normal (Box-Muller).
    pub fn normal(&mut self) -> f64 {
        let u = (1.0 - self.unit()).max(1e-12);
        let v = self.unit();
        (-2.0 * u.ln()).sqrt() * (2.0 * core::f64::consts::PI * v).cos()
    }
}

/// How the offers of a synthetic batch are drawn.
#[derive(Clone, Copy, Debug)]
pub struct Shape {
    /// The true valuations are `2^u` with `u` uniform in `[-spread, spread]` octaves.
    pub spread: f64,
    /// Each offer's limit is the true ratio times `2^(noise * N(0, 1))` octaves: how far the
    /// batch's offers disagree with the truth (and with each other).
    pub noise: f64,
    /// Amounts are `MIN_AMOUNT * 2^(U(0, 1) * amount_range)`.
    pub amount_range: f64,
}

impl Default for Shape {
    fn default() -> Self {
        Shape {
            spread: 0.75,
            noise: 0.1,
            amount_range: 16.0,
        }
    }
}

/// Q32 price of a ratio.
pub fn px(ratio: f64) -> Price {
    (ratio * PRICE_ONE as f64).round() as Price
}

/// Draw a batch of `offers` offers over `n` assets on `grid`.
pub fn batch(rng: &mut Rng, n: usize, offers: usize, grid: Grid, shape: Shape) -> Batch {
    let truth: Vec<f64> = (0..n)
        .map(|_| (rng.unit() * 2.0 - 1.0) * shape.spread)
        .collect();
    let top = grid.levels() - 1;
    let mut out = Vec::with_capacity(offers);
    while out.len() < offers {
        let sell = rng.below(n as u64) as usize;
        let buy = (sell + 1 + rng.below(n as u64 - 1) as usize) % n;
        let log_ratio = truth[sell] - truth[buy] + shape.noise * rng.normal();
        let min_price = px(log_ratio.exp2());
        // Off the grid: no such offer can be made.
        let Some(level) = grid.level_for(min_price) else {
            continue;
        };
        if level == 0 || level == top {
            continue;
        }
        let amount = (MIN_AMOUNT as f64 * (rng.unit() * shape.amount_range).exp2()) as u128;
        out.push(Offer {
            sell,
            buy,
            level,
            min_price,
            amount,
        });
    }
    let buckets = aggregate(&out, grid);
    Batch {
        n,
        grid,
        offers: out,
        buckets,
        truth,
    }
}

/// The histogram of `offers`: one bucket per occupied (orderbook, level), ordered as the contract
/// reads them.
pub fn aggregate(offers: &[Offer], grid: Grid) -> Vec<Bucket> {
    let mut cells: std::collections::BTreeMap<(usize, u32), u128> = Default::default();
    for o in offers {
        *cells
            .entry((engine::book(o.sell, o.buy), o.level))
            .or_default() += o.amount;
    }
    cells
        .into_iter()
        .map(|((book, level), amount)| Bucket {
            sell: (book / engine::MAX_ASSETS) as u8,
            buy: (book % engine::MAX_ASSETS) as u8,
            level,
            limit: grid.ratio(level),
            amount,
        })
        .collect()
}

/// The contract's histogram key for a bucket, as `Speedex::cell_of` computes it.
pub fn cell_key(b: &Bucket) -> u32 {
    ((engine::book(b.sell as usize, b.buy as usize) as u32) << 20) | b.level
}

/// The cell list `clear_batch` takes for `buckets`: keys little-endian, concatenated, ascending.
pub fn cell_list(buckets: &[Bucket]) -> Vec<u8> {
    let mut keys: Vec<u32> = buckets.iter().map(cell_key).collect();
    keys.sort_unstable();
    keys.iter().flat_map(|k| k.to_le_bytes()).collect()
}
