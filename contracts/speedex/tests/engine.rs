//! The clearing engine on its own: grid, prices, the circulation and settlement, with no contract.

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
        level,
        limit: level_ratio(level, octaves),
        amount,
    }
}

// The fill recorded for a book, or none.
fn book_fill(fills: &[(usize, BookFill)], sell: usize, buy: usize) -> Option<&BookFill> {
    fills
        .iter()
        .find(|(i, _)| *i == book(sell, buy))
        .map(|(_, f)| f)
}

// Settle a bucket as if it were one offer, under a clearing's book fills.
fn fill_of(b: &Bucket, c: &Clearing, fills: &[(usize, BookFill)]) -> Fill {
    let none = BookFill::default();
    let bf = book_fill(fills, b.sell, b.buy).unwrap_or(&none);
    fill(b.amount, b.level, bf, c.prices[b.sell], c.prices[b.buy])
}

// What every clearing must satisfy over a set of offers (here, buckets standing in for offers):
// nothing sold beyond an offer, nothing paid out of an asset beyond what was sold of it, every
// limit met up to rounding, and -- unless the lower bounds had to be dropped -- every bucket past
// the smoothing band filled in full.
fn assert_sound(buckets: &[Bucket], n: usize, c: &Clearing, fills: &[(usize, BookFill)]) {
    let mut sold = [0u128; MAX_ASSETS];
    let mut bought = [0u128; MAX_ASSETS];
    for b in buckets {
        let f = fill_of(b, c, fills);
        assert!(f.sold <= b.amount, "{f:?} of {}", b.amount);
        sold[b.sell] += f.sold;
        bought[b.buy] += f.bought;

        let limit = b.limit as f64 / PRICE_ONE as f64;
        let r = ratio(&c.prices, b.sell, b.buy);
        if f.sold > 0 {
            assert!(r > limit, "traded at {r} under limit {limit}");
        }
        assert!(
            f.bought as f64 + 1.0 >= (f.sold as f64 - 2.0) * limit,
            "{f:?} at limit {limit}"
        );
        let band = 1.0 + 1.0 / (1u64 << SMOOTH_SHIFT) as f64;
        if c.shortfall == 0 && r >= limit * band * 1.000001 {
            assert_eq!(
                f.sold, b.amount,
                "past the band but not filled: {b:?} at {r}"
            );
        }
    }
    for a in 0..n {
        assert!(
            bought[a] <= sold[a],
            "asset {a}: paid {} of {}",
            bought[a],
            sold[a]
        );
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
    let limit = PRICE_ONE;
    let band = limit >> SMOOTH_SHIFT;
    assert_eq!(fill_fraction(PRICE_ONE, PRICE_ONE, limit), 0);
    assert_eq!(fill_fraction(PRICE_ONE - 1, PRICE_ONE, limit), 0);
    let half = fill_fraction(PRICE_ONE + band / 2, PRICE_ONE, limit);
    assert!((half as f64 / ONE as f64 - 0.5).abs() < 1e-6, "{half}");
    assert_eq!(fill_fraction(PRICE_ONE + band, PRICE_ONE, limit), ONE);
    assert_eq!(fill_fraction(2 * PRICE_ONE, PRICE_ONE, limit), ONE);
}

#[test]
fn ring_of_three_clears_at_equal_prices() {
    // No orderbook has both sides: A is only sold for B, B for C, C for A. A pairwise exchange
    // would match nothing; one valuation across the three assets clears everything, and with no
    // fee and equal prices, exactly.
    let amount = 1_000_000;
    let buckets = [
        bucket(0, 1, 0.9, amount, OCTAVES),
        bucket(1, 2, 0.9, amount, OCTAVES),
        bucket(2, 0, 0.9, amount, OCTAVES),
    ];
    let (c, fills) = clear(&buckets, 3);

    for (sell, buy) in [(0, 1), (1, 2), (2, 0)] {
        assert!(
            (ratio(&c.prices, sell, buy) - 1.0).abs() < 0.02,
            "{:?}",
            c.prices
        );
    }
    assert_eq!(c.shortfall, 0);
    for b in &buckets {
        let f = fill_of(b, &c, &fills);
        assert_eq!(
            f,
            Fill {
                sold: amount,
                bought: amount
            }
        );
    }
    assert_sound(&buckets, 3, &c, &fills);
}

#[test]
fn two_sided_market_finds_the_price_that_fills_both_sides() {
    // 100 A for B at no less than 0.4 B/A; 50 B for A at no less than 1.5 A/B. Both clear when
    // p_A / p_B is between 0.4 and 0.667; equal value on both sides puts it at 0.5.
    let a_for_b = bucket(0, 1, 0.4, 100_000_000, OCTAVES);
    let b_for_a = bucket(1, 0, 1.5, 50_000_000, OCTAVES);
    let buckets = [a_for_b, b_for_a];
    let (c, fills) = clear(&buckets, 2);

    let r = ratio(&c.prices, 0, 1);
    assert!((r - 0.5).abs() < 0.02, "p_A / p_B = {r}");

    let fa = fill_of(&a_for_b, &c, &fills);
    let fb = fill_of(&b_for_a, &c, &fills);
    assert!(
        fa.sold >= 99_000_000 && fb.sold >= 49_000_000,
        "{fa:?} {fb:?}"
    );
    assert!(fa.bought.abs_diff(50_000_000) < 1_500_000, "{fa:?}");
    assert!(fb.bought.abs_diff(100_000_000) < 3_000_000, "{fb:?}");
    // The circulation balances value exactly; what stays behind is a few units of rounding.
    assert!(
        fb.sold - fa.bought <= 2 && fa.sold - fb.bought <= 4,
        "{fa:?} {fb:?}"
    );
    assert_sound(&buckets, 2, &c, &fills);
}

#[test]
fn a_limit_that_binds_fills_partially_at_the_limit() {
    // 100 A for B at 0.4 or better -- which the grid rounds up to about 0.42 -- against only 30 B
    // for A. Filling all of the A would need 42 B, so the A seller's limit binds: the 30 B buy
    // about 71 A at a ratio just above the limit, inside its smoothing band.
    let a_for_b = bucket(0, 1, 0.4, 100_000_000, OCTAVES);
    let b_for_a = bucket(1, 0, 1.0, 30_000_000, OCTAVES);
    let buckets = [a_for_b, b_for_a];
    let (c, fills) = clear(&buckets, 2);

    let limit = a_for_b.limit as f64 / PRICE_ONE as f64;
    assert!(limit > 0.4 && limit < 0.43, "grid level {limit}");
    let r = ratio(&c.prices, 0, 1);
    assert!(
        r > limit && r < limit * 1.02,
        "p_A / p_B = {r} vs limit {limit}"
    );

    // Bob's level is past the band, so it is a lower bound and all of it trades; Alice's level is
    // the marginal one and takes exactly what balances it.
    let fa = fill_of(&a_for_b, &c, &fills);
    let fb = fill_of(&b_for_a, &c, &fills);
    assert_eq!(fb.sold, 30_000_000, "{fb:?}");
    let expected_a = (30_000_000.0 / r) as u128;
    assert!(fa.sold.abs_diff(expected_a) <= 2, "{fa:?} vs {expected_a}");
    assert!(fa.bought.abs_diff(30_000_000) <= 2, "{fa:?}");
    let ab = book_fill(&fills, 0, 1).expect("A for B traded");
    assert_eq!(ab.total, a_for_b.amount);
    assert!(ab.lo <= ab.hi && ab.hi <= ab.lo + 1, "{ab:?}");
    assert_sound(&buckets, 2, &c, &fills);
}

#[test]
fn levels_fill_from_the_most_in_the_money_down() {
    // Three levels of A for B against one lot of B that covers about two of them. The lowest
    // levels fill in full, the next one takes the remainder, and the highest gets nothing.
    let buckets = [
        bucket(0, 1, 0.5, 10_000_000, OCTAVES),
        bucket(0, 1, 0.7, 10_000_000, OCTAVES),
        bucket(0, 1, 0.9, 10_000_000, OCTAVES),
        bucket(0, 1, 1.5, 10_000_000, OCTAVES),
        bucket(1, 0, 0.9, 20_000_000, OCTAVES),
    ];
    let (c, fills) = clear(&buckets, 2);
    let ab = book_fill(&fills, 0, 1).expect("A for B traded");
    let r = ratio(&c.prices, 0, 1);

    let fills_a: Vec<Fill> = buckets[..4]
        .iter()
        .map(|b| fill_of(b, &c, &fills))
        .collect();
    // Some prefix is full, one level is partial, and the rest is empty.
    let full = fills_a.iter().take_while(|f| f.sold == 10_000_000).count();
    assert!((1..=3).contains(&full), "{fills_a:?}");
    assert_eq!(
        buckets[full].level, ab.full_below,
        "{ab:?} {fills_a:?} at {r}"
    );
    assert!(
        fills_a[full].sold > 0 && fills_a[full].sold < 10_000_000,
        "{fills_a:?}"
    );
    for f in &fills_a[full + 1..] {
        assert_eq!(*f, Fill::default(), "{fills_a:?}");
    }
    assert_sound(&buckets, 2, &c, &fills);
}

#[test]
fn crossed_limits_trade_nothing() {
    // Each side wants two of the other per unit; no ratio satisfies both.
    let buckets = [
        bucket(0, 1, 2.0, 1_000_000, OCTAVES),
        bucket(1, 0, 2.0, 1_000_000, OCTAVES),
    ];
    let (c, fills) = clear(&buckets, 2);
    assert_eq!(c.volume, 0);
    assert!(fills.is_empty());
    for b in &buckets {
        assert_eq!(fill_of(b, &c, &fills), Fill::default());
    }
}

#[test]
fn buckets_up_to_i128_max_clear_without_overflow() {
    // A cell totals whatever its offers add up to, far beyond the per-offer bound. The engine must
    // neither fault nor pay out more than it takes in.
    let huge = i128::MAX as u128;
    let buckets = [
        bucket(0, 1, 0.9, huge, OCTAVES),
        bucket(1, 0, 0.9, huge, OCTAVES),
        bucket(1, 2, 0.5, huge / 3, OCTAVES),
        bucket(2, 1, 1.9, 1 << 20, OCTAVES),
    ];
    let (c, fills) = clear(&buckets, 3);
    assert!(c.volume > 0, "{c:?}");
    assert_sound(&buckets, 3, &c, &fills);

    // One offer of the largest allowed size inside the huge bucket settles at the clearing rate.
    let ab = book_fill(&fills, 0, 1).expect("A for B traded");
    let f = fill(
        MAX_AMOUNT - 1,
        buckets[0].level,
        ab,
        c.prices[0],
        c.prices[1],
    );
    assert!(f.sold < MAX_AMOUNT);
    assert!(
        f.bought as f64 + 1.0 >= (f.sold as f64 - 2.0) * 0.9,
        "{f:?}"
    );

    // And a batch with one bucket at the maximum and nothing to trade against it is fine too.
    let lone = [bucket(0, 1, 0.9, huge, OCTAVES)];
    let (c, fills) = clear(&lone, 2);
    assert_eq!(c.volume, 0);
    assert!(fills.is_empty());
}

// A small deterministic generator, so the property tests below are reproducible.
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
fn the_largest_configuration_clears_a_full_histogram() {
    // Eight assets on a one-octave grid is the most cells an exchange may have (1024). Fill every
    // one and clear it, treating each bucket as a single offer for the invariants.
    let (n, octaves) = (8, 1);
    let mut rng = Lcg(7);
    let mut buckets = Vec::new();
    for sell in 0..n {
        for buy in (0..n).filter(|&b| b != sell) {
            for level in 0..levels(octaves) {
                buckets.push(Bucket {
                    sell,
                    buy,
                    level,
                    limit: level_ratio(level, octaves),
                    amount: MIN_AMOUNT + rng.below(1 << 40) as u128,
                });
            }
        }
    }
    assert_eq!(buckets.len(), 896);
    let (c, fills) = clear(&buckets, n);
    assert!(c.volume > 0);
    assert_sound(&buckets, n, &c, &fills);
}

#[test]
fn random_batches_are_sound_and_respect_every_limit() {
    let mut rng = Lcg(2024);
    let mut relaxed = 0;
    let mut most_cancellations = 0;

    for trial in 0..300 {
        let n = 2 + rng.below(4) as usize;
        let octaves = 1 + rng.below(3) as u32;
        let n_buckets = 1 + rng.below(12) as usize;

        // Aggregate buckets, each standing for one to three offers of the same level.
        let mut buckets: Vec<Bucket> = Vec::new();
        let mut offers: Vec<(usize, usize, u32, u128)> = Vec::new();
        for _ in 0..n_buckets {
            let sell = rng.below(n as u64) as usize;
            let buy = (sell + 1 + rng.below(n as u64 - 1) as usize) % n;
            let level = rng.below(levels(octaves) as u64) as u32;
            if let Some(b) = buckets
                .iter_mut()
                .find(|b| b.sell == sell && b.buy == buy && b.level == level)
            {
                let amount = MIN_AMOUNT + rng.below(1 << 40) as u128;
                offers.push((sell, buy, level, amount));
                b.amount += amount;
                continue;
            }
            let mut total = 0;
            for _ in 0..1 + rng.below(3) {
                let amount = MIN_AMOUNT
                    + match rng.below(3) {
                        0 => rng.below(1_000),
                        1 => rng.below(1_000_000_000),
                        _ => rng.below(1 << 40),
                    } as u128;
                offers.push((sell, buy, level, amount));
                total += amount;
            }
            buckets.push(Bucket {
                sell,
                buy,
                level,
                limit: level_ratio(level, octaves),
                amount: total,
            });
        }
        // The engine expects each book's buckets in level order.
        buckets.sort_by_key(|b| (b.sell, b.buy, b.level));

        let (c, fills) = clear(&buckets, n);
        relaxed += (c.shortfall > 0) as u32;
        most_cancellations = most_cancellations.max(c.cancellations);

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

        // Settle the individual offers behind the buckets, and check the invariants over them.
        let none = BookFill::default();
        let mut sold = [0u128; MAX_ASSETS];
        let mut bought = [0u128; MAX_ASSETS];
        for &(sell, buy, level, amount) in &offers {
            let bf = book_fill(&fills, sell, buy).unwrap_or(&none);
            let f = fill(amount, level, bf, c.prices[sell], c.prices[buy]);
            assert!(f.sold <= amount, "trial {trial}: {f:?} of {amount}");
            sold[sell] += f.sold;
            bought[buy] += f.bought;

            let limit = level_ratio(level, octaves) as f64 / PRICE_ONE as f64;
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
        for a in 0..n {
            assert!(
                bought[a] <= sold[a],
                "trial {trial}, asset {a}: paid {} of {}",
                bought[a],
                sold[a]
            );
        }
        assert_sound(&buckets, n, &c, &fills);
    }
    // Where every book on a cycle is past the band, approximate prices leave a little unfilled; it
    // should never take the solver anywhere near its cycle budget.
    println!(
        "some lower bound unmet in {relaxed} of 300 batches; at most {most_cancellations} cycles"
    );
    assert!(most_cancellations < MAX_CANCELLATIONS);
}
