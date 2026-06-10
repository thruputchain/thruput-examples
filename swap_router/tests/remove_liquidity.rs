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

impl Etx {
    #[rustfmt::skip]
    pub fn prime(&self) -> Result<()> {
        println!("{}", self.record_stats(&[PRIMER])?);

        // Give an allowance of all our AB-tokens to the pair contract
        let (amounts_desired, _) = self.user_balances(PRIMER)?;
        self.user_allow_for_pair(PRIMER, amounts_desired)?;

        /* ----- */ self.advance_block(); /* ----- */

        self.user_add_liquidity(PRIMER, amounts_desired)?;

        self.process_outstanding_requests(1)?;

        /* ----- */ self.advance_block(); /* ----- */

        println!("{}", self.record_stats(&[PRIMER])?);
        Ok(())
    }

    pub fn user_add_liquidity(&self, user: User, amounts_desired: Amounts) -> Result<()> {
        let ctx = &self.ctx;

        // Request to buy into the liquidity pool
        self.exec_user_tx(user, |_| {
            // Where the LP tokens go: back to the user
            let recipient = &get_current_address();

            let amounts_min = [0, 0];

            ctx.router().add_liquidity(
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                amounts_desired,
                amounts_min,
                recipient,
            );
        })
    }

    pub fn user_allow_for_pair(&self, user: User, amounts_allowed: Amounts) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            ctx.token0()
                .adjust_allowance(&ctx.pair_addr, amounts_allowed[0].try_into().unwrap());
            ctx.token1()
                .adjust_allowance(&ctx.pair_addr, amounts_allowed[1].try_into().unwrap());
        })
    }

    pub fn user_allow_lp_for_pair(&self, user: User, liquidity: Amount) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            ctx.lp()
                .adjust_allowance(&ctx.pair_addr, liquidity.try_into().unwrap());
        })
    }

    pub fn user_remove_liquidity(
        &self,
        user: User,
        liquidity: Amount,
        amounts_min: Amounts,
    ) -> Result<()> {
        let ctx = &self.ctx;

        // Request to redeem out of the liquidity pool
        self.exec_user_tx(user, |_| {
            // Where the underlying A/B tokens go: back to the user
            let recipient = &get_current_address();

            ctx.router().remove_liquidity(
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                liquidity,
                amounts_min,
                recipient,
            );
        })
    }

    pub fn process_outstanding_requests(&self, n_requests_waiting: u32) -> Result<()> {
        let ctx = &self.ctx;

        let (n_processed, n_failed) = self.exec_tx(&TEST_ADDR, || {
            ctx.driver()
                .with_gas_limit(PROCESS_REQUESTS_GAS)
                .process_requests()
        })?;

        assert_eq!(n_processed, n_requests_waiting);
        assert_eq!(
            0, n_failed,
            "Swap driver: process_requests: Some requests failed"
        );

        println!("Processed {n_processed} requests");
        Ok(())
    }
}
