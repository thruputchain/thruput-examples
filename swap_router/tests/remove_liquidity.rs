mod common;
use common::*;

test_transaction! {
    fn alice_remove_liquidity(etx: &Etx) -> Result<()> {
        let user = ALICE;

        // First, prime the AMM, then give Alice an LP position to remove.
        etx.prime()?;

        let (amounts_desired, _) = etx.user_balances(user)?;
        etx.user_allow_for_pair(user, amounts_desired)?;

        /* ----- */ etx.advance_block(); /* ----- */

        etx.user_add_liquidity(user, amounts_desired)?;
        etx.process_outstanding_requests(1)?;

        /* ----- */ etx.advance_block(); /* ----- */

        println!("{}", etx.record_stats(&[PRIMER, user])?);

        // Alice should now hold some LP, having spent her A/B tokens.
        let (tokens_before, liquidity) = etx.user_balances(user)?;
        assert!(liquidity > 0);

        // Give the pair an allowance of all Alice's LP, then remove it all.
        etx.user_allow_lp_for_pair(user, liquidity)?;

        /* ----- */ etx.advance_block(); /* ----- */

        etx.user_remove_liquidity(user, liquidity, [0, 0])?;
        etx.process_outstanding_requests(1)?;

        /* ----- */ etx.advance_block(); /* ----- */

        // Alice should have burned all her LP and recovered A/B tokens.
        let (tokens_after, liquidity_after) = etx.user_balances(user)?;
        assert_eq!(liquidity_after, 0);
        assert!(tokens_after[0] > tokens_before[0]);
        assert!(tokens_after[1] > tokens_before[1]);

        println!("{}", etx.record_stats(&[PRIMER, user])?);
        Ok(())
    }
}
