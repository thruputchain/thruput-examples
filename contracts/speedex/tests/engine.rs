//! The clearing engine on its own: grid, prices, feasibility and settlement, with no contract.

use speedex::engine::*;

fn px(x: f64) -> Price {
    (x * PRICE_ONE as f64).round() as Price
}

fn ratio(p: &Prices, sell: usize, buy: usize) -> f64 {
    p[sell] as f64 / p[buy] as f64
}

fn bucket(sell: usize, buy: usize, limit: f64, amount: u128, octaves: u32) -> Bucket {
    let level = level_for(px(limit), octaves).expect("limit on the grid");
    Bucket {
        sell,
        buy,
        limit: level_ratio(level, octaves),
        amount,
    }
}

const OCTAVES: u32 = 2;

#[test]
fn grid_is_geometric_and_rounds_limits_up() {
    // Eight levels to the doubling, centered on one.
    assert_eq!(levels(OCTAVES), 32);
    assert_eq!(level_ratio(16, OCTAVES), PRICE_ONE);
    assert_eq!(level_ratio(24, OCTAVES), 2 * PRICE_ONE);
    assert_eq!(level_ratio(0, OCTAVES), PRICE_ONE / 4);
    for k in 1..levels(OCTAVES) {
        let step = level_ratio(k, OCTAVES) as f64 / level_ratio(k - 1, OCTAVES) as f64;
        assert!(
            (step - 2f64.powf(1.0 / 8.0)).abs() < 1e-6,
            "level {k}: {step}"
        );
    }

    // A limit lands on its level exactly, or on the next one up.
    assert_eq!(level_for(px(1.0), OCTAVES), Some(16));
    assert_eq!(level_for(px(1.01), OCTAVES), Some(17));
    assert_eq!(level_for(px(0.9), OCTAVES), Some(15));
    assert!(level_ratio(15, OCTAVES) >= px(0.9));
    assert!(level_ratio(14, OCTAVES) < px(0.9));

    // Below the grid is raised to its floor; above it is refused.
    assert_eq!(level_for(1, OCTAVES), Some(0));
    assert_eq!(level_for(px(3.9), OCTAVES), None);
    assert_eq!(level_for(px(3.6), OCTAVES), Some(31));
}

#[test]
fn fill_fraction_steps_smoothly_above_the_limit() {
    // A sell price that puts the *effective* ratio (after the fee and the haircut margin) against a
    // buy price of one at `r`, Q32.
    let sell_price_for = |r: u128| (r * FEE_DEN / FEE_KEEP * FEE_DEN / FEE_KEEP) as Price;
    let limit = PRICE_ONE;
    let band = (limit >> SMOOTH_SHIFT) as u128;

    // At the limit, before the fee, the ratio is one: nothing executes yet.
    assert_eq!(fill_fraction(PRICE_ONE, PRICE_ONE, limit), 0);
    assert_eq!(fill_fraction(sell_price_for(ONE), PRICE_ONE, limit), 0);
    let half = fill_fraction(sell_price_for(ONE + band / 2), PRICE_ONE, limit);
    assert!((half as f64 / ONE as f64 - 0.5).abs() < 1e-6, "{half}");
    assert_eq!(
        fill_fraction(sell_price_for(ONE + band) + 8, PRICE_ONE, limit),
        ONE
    );
    assert_eq!(fill_fraction(2 * PRICE_ONE, PRICE_ONE, limit), ONE);
}

#[test]
fn ring_of_three_clears_at_equal_prices() {
    // No orderbook has both sides: A is only sold for B, B for C, C for A. A pairwise exchange
    // would match nothing; one valuation across the three assets clears everything.
    let amount = 1_000_000;
    let buckets = [
        bucket(0, 1, 0.9, amount, OCTAVES),
        bucket(1, 2, 0.9, amount, OCTAVES),
        bucket(2, 0, 0.9, amount, OCTAVES),
    ];
    let c = clear(&buckets, 3);

    for (sell, buy) in [(0, 1), (1, 2), (2, 0)] {
        assert!(
            (ratio(&c.prices, sell, buy) - 1.0).abs() < 0.02,
            "{:?}",
            c.prices
        );
    }
    for b in &buckets {
        let f = fill(b.amount, b.sell, b.buy, b.limit, &c);
        assert_eq!(f.sold, amount);
        assert!(f.bought >= amount * 98 / 100, "{f:?}");
    }
}

#[test]
fn two_sided_market_finds_the_price_that_fills_both_sides() {
    // 100 A for B at no less than 0.4 B/A; 50 B for A at no less than 1.5 A/B. Both clear when
    // p_A / p_B is between 0.4 and 0.667; equal value on both sides puts it at 0.5.
    let a_for_b = bucket(0, 1, 0.4, 100_000_000, OCTAVES);
    let b_for_a = bucket(1, 0, 1.5, 50_000_000, OCTAVES);
    let c = clear(&[a_for_b, b_for_a], 2);

    let r = ratio(&c.prices, 0, 1);
    assert!((r - 0.5).abs() < 0.02, "p_A / p_B = {r}");

    let fa = fill(a_for_b.amount, 0, 1, a_for_b.limit, &c);
    let fb = fill(b_for_a.amount, 1, 0, b_for_a.limit, &c);
    assert!(
        fa.sold >= 99_000_000 && fb.sold >= 49_000_000,
        "{fa:?} {fb:?}"
    );
    assert!(fa.bought.abs_diff(50_000_000) < 1_500_000, "{fa:?}");
    assert!(fb.bought.abs_diff(100_000_000) < 3_000_000, "{fb:?}");
    // The fee: one part in 1024 of each purchase stays with the exchange.
    assert!(c.surplus[0] > 0 && c.surplus[1] > 0, "{c:?}");
    assert!(c.surplus[0] <= fa.sold - fb.bought && c.surplus[1] <= fb.sold - fa.bought);
    assert!(
        fa.bought <= fb.sold && fb.bought <= fa.sold,
        "conservation: {fa:?} {fb:?}"
    );
}

#[test]
fn a_limit_that_binds_fills_partially_at_the_limit() {
    // 100 A for B at 0.4 or better -- which the grid rounds up to about 0.42 -- against only 30 B
    // for A. Filling all of the A would need 42 B, so the A seller's limit binds: the 30 B buy
    // about 71 A at a ratio just above the limit, inside its smoothing band.
    let a_for_b = bucket(0, 1, 0.4, 100_000_000, OCTAVES);
    let b_for_a = bucket(1, 0, 1.0, 30_000_000, OCTAVES);
    let c = clear(&[a_for_b, b_for_a], 2);

    let limit = a_for_b.limit as f64 / PRICE_ONE as f64;
    assert!(limit > 0.4 && limit < 0.43, "grid level {limit}");
    let r = ratio(&c.prices, 0, 1);
    assert!(
        r > limit && r < limit * 1.02,
        "p_A / p_B = {r} vs limit {limit}"
    );

    let fa = fill(a_for_b.amount, 0, 1, a_for_b.limit, &c);
    let fb = fill(b_for_a.amount, 1, 0, b_for_a.limit, &c);
    let expected_a = (30_000_000.0 / r) as u128;
    assert!(
        fa.sold.abs_diff(expected_a) < 1_000_000,
        "{fa:?} vs {expected_a}"
    );
    assert!(fa.bought.abs_diff(30_000_000) < 500_000, "{fa:?}");
    assert!(fb.sold >= 29_500_000, "{fb:?}");
    assert!(
        fa.bought <= fb.sold && fb.bought <= fa.sold,
        "conservation: {fa:?} {fb:?}"
    );
}

#[test]
fn crossed_limits_trade_nothing() {
    // Each side wants two of the other per unit; no ratio satisfies both.
    let buckets = [
        bucket(0, 1, 2.0, 1_000_000, OCTAVES),
        bucket(1, 0, 2.0, 1_000_000, OCTAVES),
    ];
    let c = clear(&buckets, 2);
    assert_eq!(c.volume, 0);
    for b in &buckets {
        assert_eq!(fill(b.amount, b.sell, b.buy, b.limit, &c), Fill::default());
    }
}

// A small deterministic generator, so the property test below is reproducible.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn random_batches_are_feasible_and_respect_every_limit() {
    let mut rng = Lcg(2024);

    for trial in 0..300 {
        let n = 2 + rng.below(4) as usize;
        let octaves = 1 + rng.below(3) as u32;
        let n_buckets = 1 + rng.below(12) as usize;

        // Aggregate buckets, each standing for one to three offers of the same limit.
        let mut buckets: Vec<Bucket> = Vec::new();
        let mut offers: Vec<(usize, usize, Price, u128)> = Vec::new();
        for _ in 0..n_buckets {
            let sell = rng.below(n as u64) as usize;
            let buy = (sell + 1 + rng.below(n as u64 - 1) as usize) % n;
            let level = rng.below(levels(octaves) as u64) as u32;
            let limit = level_ratio(level, octaves);
            let mut total = 0;
            for _ in 0..1 + rng.below(3) {
                let amount = match rng.below(3) {
                    0 => 1 + rng.below(1_000),
                    1 => 1 + rng.below(1_000_000_000),
                    _ => 1 + rng.below(1 << 40),
                } as u128;
                offers.push((sell, buy, limit, amount));
                total += amount;
            }
            buckets.push(Bucket {
                sell,
                buy,
                limit,
                amount: total,
            });
        }

        let c = clear(&buckets, n);

        // Prices are normalized.
        assert_eq!(
            *c.prices[..n].iter().max().unwrap(),
            PRICE_ANCHOR,
            "trial {trial}"
        );
        assert!(
            c.prices[..n].iter().all(|&p| p >= MIN_PRICE),
            "trial {trial}"
        );
        assert!(c.prices[n..].iter().all(|&p| p == 0), "trial {trial}");
        assert!(c.trims.iter().all(|&t| t as u128 <= ONE), "trial {trial}");

        let mut sold = [0u128; MAX_ASSETS];
        let mut bought = [0u128; MAX_ASSETS];
        for &(sell, buy, limit, amount) in &offers {
            let f = fill(amount, sell, buy, limit, &c);
            assert!(f.sold <= amount, "trial {trial}: {f:?} of {amount}");
            sold[sell] += f.sold;
            bought[buy] += f.bought;

            // The effective price is the limit or better, up to the rounding `fill` documents.
            let limit = limit as f64 / PRICE_ONE as f64;
            assert!(
                f.bought as f64 + 1.0 >= (f.sold as f64 - 2.0) * limit,
                "trial {trial}: {f:?} at limit {limit}"
            );
            if f.sold > 0 {
                let r = ratio(&c.prices, sell, buy);
                assert!(
                    r > limit,
                    "trial {trial}: traded at {r} under limit {limit}"
                );
            }
        }

        // What the exchange pays out of each asset never exceeds what it took in, and the surplus
        // it promised the fee collector is covered by what is left.
        for a in 0..n {
            assert!(
                bought[a] <= sold[a],
                "trial {trial}, asset {a}: paid {} of {}",
                bought[a],
                sold[a]
            );
            assert!(
                c.surplus[a] <= sold[a] - bought[a],
                "trial {trial}, asset {a}: {c:?}"
            );
        }
    }
}
