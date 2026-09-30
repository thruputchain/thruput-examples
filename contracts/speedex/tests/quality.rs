//! Execution quality of the engine on synthetic batches: how well the prices clear the market,
//! how much of what should trade does, and how that changes with the tâtonnement round cap, the
//! number of assets and the number of offers.
//!
//! Ignored: it is a benchmark, not a check. Run it with
//!
//! ```text
//! cargo test -p speedex --release --test quality -- --ignored --nocapture
//! ```
//!
//! It prints a summary and writes every run as a CSV row to `SPEEDEX_QUALITY_OUT`
//! (default: `speedex-quality.csv` in the workspace's `target/`); `scripts/speedex-plot.py` graphs that file. Gas is not
//! measured here -- the mock environment does not meter it -- but by `tests/testkit_gas.rs` on a
//! devnode; the native timings below are only a proxy for the shape of the cost.
//!
//! Every batch is drawn by [`synthetic::batch`]: offers whose limits scatter around a hidden set
//! of true valuations. That gives every batch a clearing to find and a truth to judge the found
//! prices against.

mod synthetic;

use std::io::Write;
use std::time::Instant;

use speedex::engine::{self, Bucket, Grid, Prices, TOLERANCE};
use synthetic::{Batch, Rng, Shape};

/// The grid every batch uses: two doublings either side of one, 4096 levels to the doubling (the
/// same as `tests/batch.rs`).
const GRID: Grid = Grid {
    octaves: 2,
    level_bits: 12,
};

const ROUND_CAPS: [u32; 14] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256];
const ASSETS: [usize; 5] = [3, 4, 5, 6, 8];
const OFFERS: [usize; 7] = [10, 30, 100, 300, 1000, 3000, 10000];
const SEEDS: u64 = 5;

/// One run's measurements.
#[derive(Clone, Debug)]
struct Row {
    n: usize,
    offers: usize,
    cells: usize,
    seed: u64,
    round_cap: u32,
    rounds: u32,
    converged: bool,
    /// Value of the excess demand at the found prices, relative to the value supplied.
    price_error: f64,
    /// The worst asset's deviation of the found valuations from the truth, in octaves.
    price_deviation: f64,
    /// Value traded, relative to the value of every bucket in the money at the found prices.
    fill_fraction: f64,
    /// Value of the buckets past the smoothing band that did not trade, relative to all of them.
    shortfall_fraction: f64,
    /// Of the offers in the money at the found prices: how many filled in full, in part, not at
    /// all.
    offers_in_money: usize,
    offers_full: usize,
    offers_partial: usize,
    offers_unfilled: usize,
    /// Of the offers past the smoothing band (the ones SPEEDEX requires to trade): how many did
    /// not fill in full.
    offers_must: usize,
    offers_must_short: usize,
    pivots: u32,
    prices_us: u128,
    trades_us: u128,
}

const HEADER: &str = "n,offers,cells,seed,round_cap,rounds,converged,price_error,price_deviation,\
fill_fraction,shortfall_fraction,offers_in_money,offers_full,offers_partial,offers_unfilled,\
offers_must,offers_must_short,pivots,prices_us,trades_us";

impl Row {
    fn csv(&self) -> String {
        format!(
            "{},{},{},{},{},{},{},{:.3e},{:.5},{:.5},{:.3e},{},{},{},{},{},{},{},{},{}",
            self.n,
            self.offers,
            self.cells,
            self.seed,
            self.round_cap,
            self.rounds,
            self.converged as u8,
            self.price_error,
            self.price_deviation,
            self.fill_fraction,
            self.shortfall_fraction,
            self.offers_in_money,
            self.offers_full,
            self.offers_partial,
            self.offers_unfilled,
            self.offers_must,
            self.offers_must_short,
            self.pivots,
            self.prices_us,
            self.trades_us,
        )
    }
}

fn to_f64(x: u128) -> f64 {
    x as f64
}

/// Value of a bucket's amount at the sell price, in the units of `Clearing::volume`.
fn value(b: &Bucket, p: &Prices) -> f64 {
    to_f64(b.amount) * to_f64(p[b.sell as usize] as u128) / to_f64(engine::ONE)
}

/// How far `found` is from `truth`, as the worst asset's log2 deviation after aligning the two
/// vectors at their geometric means.
fn deviation(found: &Prices, truth: &[f64]) -> f64 {
    let n = truth.len();
    let logs: Vec<f64> = (0..n).map(|a| (found[a] as f64).log2()).collect();
    let mean_found = logs.iter().sum::<f64>() / n as f64;
    let mean_truth = truth.iter().sum::<f64>() / n as f64;
    (0..n)
        .map(|a| ((logs[a] - mean_found) - (truth[a] - mean_truth)).abs())
        .fold(0.0, f64::max)
}

fn evaluate(batch: &Batch, seed: u64, round_cap: u32) -> Row {
    let n = batch.n;
    let started = Instant::now();
    let (prices, rounds) = engine::tatonnement(&batch.buckets, n, round_cap);
    let prices_us = started.elapsed().as_micros();
    let started = Instant::now();
    let (clearing, fills) = engine::trades(&batch.buckets, n, &prices, rounds);
    let trades_us = started.elapsed().as_micros();

    let (err, volume) = engine::imbalance(&batch.buckets, n, &prices);
    let converged = volume > 0 && err.saturating_mul(TOLERANCE) <= volume;

    // What is in the money, and what must trade, at these prices.
    let mut in_money = 0.0;
    let mut must = 0.0;
    for b in &batch.buckets {
        let phi = engine::fill_fraction(prices[b.sell as usize], prices[b.buy as usize], b.limit);
        if phi > 0 {
            in_money += value(b, &prices);
        }
        if phi == engine::ONE {
            must += value(b, &prices);
        }
    }

    // Each offer's settlement, from its book's fill.
    let mut book_fills = [engine::BookFill::default(); engine::MAX_BOOKS];
    let mut traded = [false; engine::MAX_BOOKS];
    for (book, fill) in &fills {
        book_fills[*book] = *fill;
        traded[*book] = true;
    }
    let (mut offers_in_money, mut offers_full, mut offers_partial, mut offers_unfilled) =
        (0, 0, 0, 0);
    let (mut offers_must, mut offers_must_short) = (0, 0);
    for o in &batch.offers {
        let limit = batch.grid.ratio(o.level);
        let phi = engine::fill_fraction(prices[o.sell], prices[o.buy], limit);
        if phi == 0 {
            continue;
        }
        offers_in_money += 1;
        let book = engine::book(o.sell, o.buy);
        let fill = if traded[book] {
            engine::fill(
                o.amount,
                o.level,
                &book_fills[book],
                prices[o.sell],
                prices[o.buy],
            )
        } else {
            engine::Fill::default()
        };
        let full = fill.sold == o.amount;
        if full {
            offers_full += 1;
        } else if fill.sold > 0 {
            offers_partial += 1;
        } else {
            offers_unfilled += 1;
        }
        if phi == engine::ONE {
            offers_must += 1;
            if !full {
                offers_must_short += 1;
            }
        }
    }

    Row {
        n,
        offers: batch.offers.len(),
        cells: batch.buckets.len(),
        seed,
        round_cap,
        rounds,
        converged,
        price_error: if volume > 0 {
            to_f64(err) / to_f64(volume)
        } else {
            1.0
        },
        price_deviation: deviation(&prices, &batch.truth),
        fill_fraction: if in_money > 0.0 {
            to_f64(clearing.volume) / in_money
        } else {
            0.0
        },
        shortfall_fraction: if must > 0.0 {
            to_f64(clearing.shortfall) / must
        } else {
            0.0
        },
        offers_in_money,
        offers_full,
        offers_partial,
        offers_unfilled,
        offers_must,
        offers_must_short,
        pivots: clearing.pivots,
        prices_us,
        trades_us,
    }
}

fn mean(rows: &[&Row], f: impl Fn(&Row) -> f64) -> f64 {
    rows.iter().map(|r| f(r)).sum::<f64>() / rows.len().max(1) as f64
}

#[test]
#[ignore = "a benchmark; run with --ignored --nocapture, preferably --release"]
fn execution_quality() {
    let out = std::env::var("SPEEDEX_QUALITY_OUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/speedex-quality.csv")
        });
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).expect("creating the output directory");
    }
    let mut rows: Vec<Row> = Vec::new();

    for &n in &ASSETS {
        for &offers in &OFFERS {
            for seed in 0..SEEDS {
                let mut rng = Rng::new(seed ^ ((n as u64) << 32) ^ ((offers as u64) << 48));
                let batch = synthetic::batch(&mut rng, n, offers, GRID, Shape::default());
                for &cap in &ROUND_CAPS {
                    rows.push(evaluate(&batch, seed, cap));
                }
            }
        }
    }

    let mut file = std::fs::File::create(&out).expect("creating the CSV");
    writeln!(file, "{HEADER}").unwrap();
    for r in &rows {
        writeln!(file, "{}", r.csv()).unwrap();
    }
    println!("wrote {} runs to {}", rows.len(), out.display());

    // A summary: the round cap's effect at a fixed size, then size's effect at the full cap.
    println!(
        "\n== round cap, {} assets, 1000 offers (mean over {SEEDS} seeds) ==",
        4
    );
    println!(
        "{:>4} {:>6} {:>11} {:>10} {:>8} {:>10} {:>10} {:>9}",
        "cap", "rounds", "price_err", "dev_oct", "fill", "shortfall", "must_shrt", "prices_us"
    );
    for &cap in &ROUND_CAPS {
        let sel: Vec<&Row> = rows
            .iter()
            .filter(|r| r.n == 4 && r.offers == 1000 && r.round_cap == cap)
            .collect();
        println!(
            "{:>4} {:>6.1} {:>11.3e} {:>10.4} {:>8.4} {:>10.3e} {:>10.4} {:>9.0}",
            cap,
            mean(&sel, |r| r.rounds as f64),
            mean(&sel, |r| r.price_error),
            mean(&sel, |r| r.price_deviation),
            mean(&sel, |r| r.fill_fraction),
            mean(&sel, |r| r.shortfall_fraction),
            mean(&sel, |r| r.offers_must_short as f64
                / r.offers_must.max(1) as f64),
            mean(&sel, |r| r.prices_us as f64),
        );
    }

    println!("\n== assets x offers at a cap of 64 rounds (mean over {SEEDS} seeds) ==");
    println!(
        "{:>2} {:>6} {:>6} {:>6} {:>11} {:>10} {:>8} {:>10} {:>10} {:>9}",
        "n",
        "offers",
        "cells",
        "rounds",
        "price_err",
        "dev_oct",
        "fill",
        "shortfall",
        "must_shrt",
        "prices_us"
    );
    for &n in &ASSETS {
        for &offers in &OFFERS {
            let sel: Vec<&Row> = rows
                .iter()
                .filter(|r| r.n == n && r.offers == offers && r.round_cap == 64)
                .collect();
            println!(
                "{:>2} {:>6} {:>6.0} {:>6.1} {:>11.3e} {:>10.4} {:>8.4} {:>10.3e} {:>10.4} {:>9.0}",
                n,
                offers,
                mean(&sel, |r| r.cells as f64),
                mean(&sel, |r| r.rounds as f64),
                mean(&sel, |r| r.price_error),
                mean(&sel, |r| r.price_deviation),
                mean(&sel, |r| r.fill_fraction),
                mean(&sel, |r| r.shortfall_fraction),
                mean(&sel, |r| r.offers_must_short as f64
                    / r.offers_must.max(1) as f64),
                mean(&sel, |r| r.prices_us as f64),
            );
        }
    }
}
