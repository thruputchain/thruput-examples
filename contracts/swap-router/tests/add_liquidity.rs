mod common;
use common::*;

test_transaction! {
    fn alice_add_liquidity(etx: &Etx) -> Result<()> {
        let user = ALICE;

        // First, prime the AMM
        etx.prime()?;

        println!("{}", etx.record_stats(&[PRIMER, user])?);

        let (amounts_available, _) = etx.user_balances(user)?;

        // Give an allowance of AB-tokens to the pair contract
        let amounts_desired = amounts_available; // use all we have
        // let amounts_desired = [10*UNIT_AMT, 10*UNIT_AMT];

        etx.user_allow_for_pair(user, amounts_desired)?;

        /* ----- */ etx.advance_block(); /* ----- */

        etx.user_add_liquidity(ALICE, amounts_desired)?;

        etx.process_outstanding_requests(1)?;

        /* ----- */ etx.advance_block(); /* ----- */

        println!("{}", etx.record_stats(&[PRIMER, ALICE])?);
        Ok(())
    }

    fn primer_add_liquidity(etx: &Etx) -> Result<()> {
        etx.prime()
    }
}
