mod common;
use common::*;

const SWAP_IN_AMT: Amount = 2 * UNIT_AMT;

test_transaction! {
    // Carol swaps an exact amount of token0 for as much token1 as possible
    #[rustfmt::skip]
    fn carol_swap_exact_tokens_for_tokens(etx: &Etx) -> Result<()> {
        let user = CAROL;

        // First, prime the AMM
        etx.prime()?;

        let (start, start_lp) = etx.user_balances(user)?;

        let amount_in = SWAP_IN_AMT;

        // The output we expect, calculated independently of the router
        let [_, expected_out] = etx.calculate_swap([amount_in, 0])?;

        // Give the pair an allowance of exactly the input amount
        etx.user_allow_for_pair(user, [amount_in, 0])?;

        /* ----- */ etx.advance_block(); /* ----- */

        // Request the swap, demanding no less than the expected output
        let amount_out =
            etx.user_swap_exact_in(user, 0, amount_in, expected_out)?;
        assert_eq!(amount_out, expected_out);

        etx.process_outstanding_requests(1)?;

        /* ----- */ etx.advance_block(); /* ----- */

        etx.user_print_balances(user)?;

        // We paid exactly `amount_in` and received exactly `amount_out`
        let (end, end_lp) = etx.user_balances(user)?;
        assert_eq!(end[0], start[0] - amount_in);
        assert_eq!(end[1], start[1] + amount_out);
        assert_eq!(end_lp, start_lp);

        // The allowance was fully consumed
        assert_eq!(etx.user_pledges(user)?, [0, 0]);

        Ok(())
    }

    // Dave swaps as little token1 as possible for an exact amount of token0
    #[rustfmt::skip]
    fn dave_swap_tokens_for_exact_tokens(etx: &Etx) -> Result<()> {
        let user = DAVE;

        // First, prime the AMM
        etx.prime()?;

        let (start, start_lp) = etx.user_balances(user)?;

        let amount_out = SWAP_IN_AMT;

        // Give the pair an allowance of more than the swap should need
        let amount_in_max = 2 * SWAP_IN_AMT;
        etx.user_allow_for_pair(user, [0, amount_in_max])?;

        /* ----- */ etx.advance_block(); /* ----- */

        // Request the swap
        let amount_in =
            etx.user_swap_exact_out(user, 1, amount_out, amount_in_max)?;
        assert!(amount_in <= amount_in_max);

        etx.process_outstanding_requests(1)?;

        /* ----- */ etx.advance_block(); /* ----- */

        etx.user_print_balances(user)?;

        // We received exactly `amount_out` and paid exactly `amount_in` (no
        // more, despite the generous allowance)
        let (end, end_lp) = etx.user_balances(user)?;
        assert_eq!(end[0], start[0] + amount_out);
        assert_eq!(end[1], start[1] - amount_in);
        assert_eq!(end_lp, start_lp);

        // The surplus allowance remains ungranted to the pair
        assert_eq!(etx.user_pledges(user)?, [0, amount_in_max - amount_in]);

        Ok(())
    }

    // The router rejects swaps that violate the user's limits
    fn swap_limits_respected(etx: &Etx) -> Result<()> {
        let user = CAROL;

        // First, prime the AMM
        etx.prime()?;

        etx.user_allow_for_pair(user, [SWAP_IN_AMT, 0])?;

        /* ----- */ etx.advance_block(); /* ----- */

        // With the 0.3% fee, the output can never reach the input amount
        // (the AMM was primed with equal reserves of both tokens)
        let r = etx.user_swap_exact_in(user, 0, SWAP_IN_AMT, SWAP_IN_AMT);
        assert_router_error(r, SwapRouterError::InsufficientOutputAmount);

        // ... and conversely, the input must exceed the output amount
        let r = etx.user_swap_exact_out(user, 0, SWAP_IN_AMT, SWAP_IN_AMT);
        assert_router_error(r, SwapRouterError::ExcessiveInputAmount);

        Ok(())
    }
}

impl Etx {
    // Primer buys liquidity directly from the pair, establishing a price
    pub fn prime(&self) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(PRIMER, |u| ctx.user_buy_unpriced(u))?;

        /* ----- */ self.advance_block(); /* ----- */

        Ok(())
    }

    // Via the router, swap an exact amount of the token at `in_index` for
    // the other token
    pub fn user_swap_exact_in(
        &self,
        user: User,
        in_index: usize,
        amount_in: Amount,
        amount_out_min: Amount,
    ) -> Result<Amount> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            // Where the output tokens go: back to the user
            let recipient = &get_current_address();

            ctx.router().swap_exact_tokens_for_tokens(
                amount_in,
                amount_out_min,
                &ctx.token_addrs[in_index],
                &ctx.token_addrs[1 - in_index],
                recipient,
            )
        })
    }

    // Via the router, swap the token at `in_index` for an exact amount of
    // the other token
    pub fn user_swap_exact_out(
        &self,
        user: User,
        in_index: usize,
        amount_out: Amount,
        amount_in_max: Amount,
    ) -> Result<Amount> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            // Where the output tokens go: back to the user
            let recipient = &get_current_address();

            ctx.router().swap_tokens_for_exact_tokens(
                amount_out,
                amount_in_max,
                &ctx.token_addrs[in_index],
                &ctx.token_addrs[1 - in_index],
                recipient,
            )
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

#[track_caller]
fn assert_router_error<T: std::fmt::Debug>(r: Result<T>, expected: SwapRouterError) {
    let r = r.expect_err("expected the transaction to abort");
    assert!(r.frame().is_abort());

    let raw = RawException::from_abort_buf(r.frame().abort_buffer()).unwrap();
    assert_eq!(raw.try_as::<SwapRouterError>(), Some(expected));
}
