mod common;
use common::*;

use swap_pair::u256::U256;

// Confirm that the price accumulator behaves sanely: after time elapses at
// fixed reserves, each cumulative price advances by the UQ112x112-encoded spot
// price times the elapsed blocks -- preserving the fraction that a plain
// integer division would discard.
#[test]
fn cumulative_price_accumulates() {
    transact_assert_success(|| {
        // Establish reserves (the primer buys equal amounts of each token).
        let etx = setup_pair_primed()?;
        let ctx = etx.ctx; // `Ctx` is `Copy`; move a copy into each closure.

        // Skew the reserves so the spot prices are fractional: Alice donates
        // her token0 to the pair, then a `sync()` records the new, unequal
        // reserves (r0 > r1). Now price0 = r1/r0 < 1.
        etx.exec_user_tx(ALICE, move |_| {
            let amt = ctx.token0().get_balance();
            ctx.token0().transfer(&ctx.pair_addr, amt);
        })?;
        etx.advance_block();
        etx.exec_tx(&TEST_ADDR, move || ctx.pair().sync())?;
        etx.advance_block();

        // Baseline: the (now skewed) reserves and the accumulator as recorded.
        let (r0, r1, ts0, cum0) = etx.exec_tx(&TEST_ADDR, move || {
            let pair = ctx.pair();
            let (r0, r1, ts) = pair.get_reserves();
            (r0, r1, ts, pair.get_cumulative_prices())
        })?;
        assert!(r0 > r1, "expected skewed reserves for a fractional price");

        // Let some blocks elapse before re-recording.
        for _ in 0..5 {
            etx.advance_block();
        }

        // `sync()` re-records the (unchanged) reserves, advancing the cumulative
        // prices over the elapsed interval.
        etx.exec_tx(&TEST_ADDR, move || ctx.pair().sync())?;
        etx.advance_block();

        let (_, _, ts1, cum1) = etx.exec_tx(&TEST_ADDR, move || {
            let pair = ctx.pair();
            let (r0, r1, ts) = pair.get_reserves();
            (r0, r1, ts, pair.get_cumulative_prices())
        })?;

        let elapsed = ts1 - ts0;
        assert!(elapsed > 0, "expected blocks to elapse between updates");

        // Reserves are unchanged across the window, so each cumulative price
        // advances by exactly the per-block price times the elapsed blocks:
        //   price0 = (r1 << 112) / r0,  price1 = (r0 << 112) / r1.
        let expected0 = (U256::from(r1) << 112) / U256::from(r0) * U256::from(elapsed);
        let expected1 = (U256::from(r0) << 112) / U256::from(r1) * U256::from(elapsed);

        let delta0 = cum1[0] - cum0[0];
        let delta1 = cum1[1] - cum0[1];

        // Since r0 > r1, the true price0 is a fraction below 1. The fixed-point
        // encoding preserves it.
        assert!(delta0 > U256::zero());
        assert_eq!(delta0, expected0);
        assert_eq!(delta1, expected1);

        Ok(())
    });
}
