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
        let etx = setup_etx_primed()?;
        let ctx = etx.ctx; // `Ctx` is `Copy`; move a copy into each closure.

        // Skew the reserves so the spot prices are fractional: Alice donates
        // her token0 to the pair, then a `sync()` records the new, unequal
        // reserves (r0 > r1). Now price0 = r1/r0 < 1.
        etx.exec_user_tx(ALICE, move |_| {
            let amt = ctx.token0().get_balance();
            ctx.token0().transfer(&ctx.pair_addr, amt);
        })?;
        etx.advance_block();
        etx.exec_as_pair(|pair| pair.sync())?;
        etx.advance_block();

        // Baseline: the (now skewed) reserves and the accumulator as recorded.
        let (r0, r1, ts0, cum0) = etx.exec_as_pair(|pair| {
            let (r0, r1, ts) = pair.get_reserves();
            (r0, r1, ts, pair.get_cumulative_prices())
        })?;
        assert!(r0 > r1, "expected skewed reserves for a fractional price");

        // Let some blocks elapse before re-recording.
        for _ in 0..5 {
            etx.advance_block();
        }

        // A `sync()` with nothing to record records nothing -- not even the
        // passage of time.  The accumulator is a function of the reserves'
        // history, and that history has not changed; a consumer wanting the
        // value as of *now* extrapolates from the recorded reserves and
        // timestamp, as UniswapV2's oracle library does.
        etx.exec_as_pair(|pair| pair.sync())?;
        etx.advance_block();
        let (_, _, ts_idle, cum_idle) = etx.exec_as_pair(|pair| {
            let (r0, r1, ts) = pair.get_reserves();
            (r0, r1, ts, pair.get_cumulative_prices())
        })?;
        assert_eq!(ts_idle, ts0, "an idle sync leaves the record alone");
        assert_eq!(cum_idle, cum0);

        // The next update that does change the reserves -- here, a further
        // donation of one unit, then a `sync()` that records it -- accounts
        // for the whole interval at the reserves that held throughout it.
        etx.exec_user_tx(BOB, move |_| {
            ctx.token0().transfer(&ctx.pair_addr, 1);
        })?;
        etx.advance_block();
        etx.exec_as_pair(|pair| pair.sync())?;
        etx.advance_block();

        let (_, _, ts1, cum1) = etx.exec_as_pair(|pair| {
            let (r0, r1, ts) = pair.get_reserves();
            (r0, r1, ts, pair.get_cumulative_prices())
        })?;

        let elapsed = ts1 - ts0;
        assert!(elapsed > 5, "expected blocks to elapse between updates");

        // Reserves were unchanged across the window, so each cumulative price
        // advances by exactly the per-block price times the elapsed blocks:
        //   price0 = (r1 << 112) / r0,  price1 = (r0 << 112) / r1.
        let expected0 = (U256::from(r1) << 112) / U256::from(r0) * U256::from_u32(elapsed);
        let expected1 = (U256::from(r0) << 112) / U256::from(r1) * U256::from_u32(elapsed);

        let delta0 = cum1[0] - cum0[0];
        let delta1 = cum1[1] - cum0[1];

        // Since r0 > r1, the true price0 is a fraction below 1. The fixed-point
        // encoding preserves it.
        assert!(delta0 > U256::ZERO);
        assert_eq!(delta0, expected0);
        assert_eq!(delta1, expected1);

        Ok(())
    });
}
