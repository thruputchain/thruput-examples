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

        // The output we expect, calculated independently of the router.
        // (Since no other request executes first, the reserves at execution
        // time match those now, so this prediction holds.)
        let [_, expected_out] = etx.calculate_swap([amount_in, 0])?;

        // Allow the handler to pull exactly the input amount
        etx.user_allow_for_pair(user, [amount_in, 0])?;

        /* ----- */ etx.advance_block(); /* ----- */

        // Request the swap, demanding no less than the expected output.
        etx.user_swap_exact_in(user, 0, amount_in, expected_out)?;

        etx.process_outstanding_requests(1)?;

        /* ----- */ etx.advance_block(); /* ----- */

        etx.user_print_balances(user)?;

        // We paid exactly `amount_in` and received exactly `expected_out`
        let (end, end_lp) = etx.user_balances(user)?;
        assert_eq!(end[0], start[0] - amount_in);
        assert_eq!(end[1], start[1] + expected_out);
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

        // Give the handler an allowance of more than the swap should need
        let amount_in_max = 2 * SWAP_IN_AMT;
        etx.user_allow_for_pair(user, [0, amount_in_max])?;

        /* ----- */ etx.advance_block(); /* ----- */

        // Request the swap (the input amount is determined at execution time)
        etx.user_swap_exact_out(user, 1, amount_out, amount_in_max)?;

        etx.process_outstanding_requests(1)?;

        /* ----- */ etx.advance_block(); /* ----- */

        etx.user_print_balances(user)?;

        // We received exactly `amount_out`, and paid no more than the cap.
        let (end, end_lp) = etx.user_balances(user)?;
        let amount_in = start[1] - end[1];
        assert_eq!(end[0], start[0] + amount_out);
        assert!(amount_in > 0 && amount_in <= amount_in_max);
        assert_eq!(end_lp, start_lp);

        // Only the amount actually needed was consumed; the surplus allowance
        // remains ungranted.
        assert_eq!(etx.user_pledges(user)?, [0, amount_in_max - amount_in]);

        Ok(())
    }

    // The slippage limits are enforced when the request is executed: a request
    // that violates them is accepted, but fails during processing (leaving the
    // user's funds untouched) rather than aborting the requesting transaction.
    fn swap_limits_respected(etx: &Etx) -> Result<()> {
        let user = CAROL;

        // First, prime the AMM
        etx.prime()?;

        let (start, _) = etx.user_balances(user)?;

        etx.user_allow_for_pair(user, [SWAP_IN_AMT, 0])?;

        /* ----- */ etx.advance_block(); /* ----- */

        // With the 0.3% fee, the output can never reach the input amount (the
        // AMM was primed with equal reserves of both tokens).  The request is
        // enqueued successfully...
        etx.user_swap_exact_in(user, 0, SWAP_IN_AMT, SWAP_IN_AMT)?;

        // ...but fails when handled.
        assert_eq!(etx.process_requests()?, (1, 1));

        /* ----- */ etx.advance_block(); /* ----- */

        // The failed request left Carol's funds untouched.
        let (after, _) = etx.user_balances(user)?;
        assert_eq!(after, start);
        assert_eq!(etx.user_pledges(user)?, [SWAP_IN_AMT, 0]);

        /* ----- */ etx.advance_block(); /* ----- */

        // Conversely, demanding an exact output while capping the input below
        // what it costs also fails at execution time.
        etx.user_swap_exact_out(user, 0, SWAP_IN_AMT, SWAP_IN_AMT)?;
        assert_eq!(etx.process_requests()?, (1, 1));

        Ok(())
    }
}
