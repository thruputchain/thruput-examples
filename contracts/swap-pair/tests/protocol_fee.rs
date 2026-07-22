mod common;
use common::*;

use swap_pair::u256::U256;

// Recipient of the protocol fee.
hash_ident! { pub static FEE_ADDR: ContractAddress; }

// Confirm the protocol fee: when `fee_to` is set, a liquidity event mints LP
// to it equal to 1/6 of the growth in sqrt(k) accrued since the previous
// liquidity event.
#[test]
fn protocol_fee_mints_to_fee_to() {
    transact_assert_success(|| {
        // Prime the pool with the fee enabled. The prime is the first liquidity
        // event, so it records `k_last` but mints no fee (there is no prior k).
        let etx = setup_pair_primed_with_fee(&FEE_ADDR)?;
        let ctx = etx.ctx;

        // Reserves at that last liquidity event give `k_last = r0 * r1`.
        let (p0, p1, _) = etx.exec_tx(&TEST_ADDR, move || ctx.pair().get_reserves())?;
        let k_last = U256::from(p0) * U256::from(p1);

        // No fee has been minted yet.
        let fee_before = etx.exec_tx(&TEST_ADDR, move || ctx.lp().get_balance_of(&FEE_ADDR))?;
        assert_eq!(fee_before, 0);

        // Simulate fees accruing into the reserves: Alice donates both tokens to
        // the pair, then `sync()` records the higher reserves (just as swaps
        // would grow the recorded reserves in normal operation).
        etx.exec_user_tx(ALICE, move |_| {
            ctx.token0().transfer(&ctx.pair_addr, ctx.token0().get_balance());
            ctx.token1().transfer(&ctx.pair_addr, ctx.token1().get_balance());
        })?;
        etx.advance_block();
        etx.exec_tx(&TEST_ADDR, move || ctx.pair().sync())?;
        etx.advance_block();

        // Snapshot the reserves and LP supply as the next liquidity event will
        // see them (before it runs).
        let (r0, r1, _) = etx.exec_tx(&TEST_ADDR, move || ctx.pair().get_reserves())?;
        let total_supply = etx.exec_tx(&TEST_ADDR, move || ctx.pair().get_liquidity())?;

        // A liquidity event (Bob adds liquidity) triggers the fee mint.
        etx.exec_user_tx(BOB, |u| ctx.user_buy(u))?;
        etx.advance_block();

        let fee_minted = etx.exec_tx(&TEST_ADDR, move || ctx.lp().get_balance_of(&FEE_ADDR))?;

        // Expected: totalSupply * (rootK - rootKLast) / (5 * rootK + rootKLast).
        let root_k = (U256::from(r0) * U256::from(r1)).integer_sqrt();
        let root_k_last = k_last.integer_sqrt();
        let expected =
            U256::from(total_supply) * (root_k - root_k_last) / (root_k * U256::from(5) + root_k_last);

        assert!(expected > U256::zero(), "donation should have grown k");
        assert_eq!(U256::from(fee_minted), expected);

        Ok(())
    });
}

// With `fee_to` unset (the zero address), no protocol fee is ever minted.
#[test]
fn no_fee_when_fee_to_unset() {
    transact_assert_success(|| {
        let etx = setup_pair_primed()?; // fee disabled
        let ctx = etx.ctx;

        // Grow k via a donation + sync, as above.
        etx.exec_user_tx(ALICE, move |_| {
            ctx.token0().transfer(&ctx.pair_addr, ctx.token0().get_balance());
            ctx.token1().transfer(&ctx.pair_addr, ctx.token1().get_balance());
        })?;
        etx.advance_block();
        etx.exec_tx(&TEST_ADDR, move || ctx.pair().sync())?;
        etx.advance_block();

        // A liquidity event must not mint any fee to the zero address.
        let supply_before = etx.exec_tx(&TEST_ADDR, move || ctx.pair().get_liquidity())?;
        etx.exec_user_tx(BOB, |u| ctx.user_buy(u))?;
        etx.advance_block();

        let zero_bal = etx.exec_tx(&TEST_ADDR, move || {
            ctx.lp().get_balance_of(&ContractAddress::zero())
        })?;

        // The only LP ever sent to the zero address is the locked
        // MINIMUM_LIQUIDITY from the initial mint -- no fee on top of it.
        assert_eq!(zero_bal, 1000);
        assert!(supply_before > 0);

        Ok(())
    });
}
