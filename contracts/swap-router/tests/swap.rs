mod common;
use common::*;
use swap_pair::events::SwapEvent;

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

// Carol pays the input, Bob receives the proceeds.  The two roles are distinct
// in the swap requests (`trader`/`recipient`), and must stay distinct through
// the handler and `swap` to the `SwapEvent`.
#[test]
fn swap_pays_proceeds_to_someone_other_than_the_trader() {
    let etx = setup_etx().expect("setup");
    let ctx = etx.ctx;

    etx.prime().expect("prime");

    let amount_in = SWAP_IN_AMT;
    etx.user_allow_for_pair(CAROL, [amount_in, 0])
        .expect("allow");
    etx.advance_block();

    let (carol_before, _) = etx.user_balances(CAROL).expect("balances");
    let (bob_before, _) = etx.user_balances(BOB).expect("balances");

    // Carol submits, naming Bob as the recipient of the output tokens.
    etx.exec_user_tx(CAROL, |_| {
        ctx.router().swap_exact_tokens_for_tokens(
            amount_in,
            0,
            &ctx.token_addrs[0],
            &ctx.token_addrs[1],
            BOB.addr,
        );
    })
    .expect("swap_exact_tokens_for_tokens");
    etx.advance_block();

    let (r, counts) = etx.process_requests_capturing();
    assert_eq!(counts, (1, 0), "one request processed, none failed");

    // The SwapEvent names both roles: Carol paid the input (topic 1), Bob
    // received the proceeds (topic 2).
    let swap = sole_event::<SwapEvent>(&r);
    assert_eq!(swap.topic(1).expect("sender topic"), CAROL.addr.as_ref());
    assert_eq!(swap.topic(2).expect("recipient topic"), BOB.addr.as_ref());

    let typed = TypedEvent::<SwapEvent>::new(swap.raw());
    let payload = typed.payload();
    let (amounts_in, amounts_out) = (payload.amounts_in, payload.amounts_out);
    assert_eq!(amounts_in, [amount_in, 0]);
    assert!(amounts_out[1] > 0);

    // ...and the tokens really moved that way: Carol paid, Bob was paid.
    etx.advance_block();
    let (carol_after, _) = etx.user_balances(CAROL).expect("balances");
    let (bob_after, _) = etx.user_balances(BOB).expect("balances");

    assert_eq!(
        carol_after,
        [carol_before[0] - amount_in, carol_before[1]],
        "trader paid the input and received nothing"
    );
    assert_eq!(
        bob_after,
        balances_sum(bob_before, amounts_out),
        "recipient received exactly what the event reported"
    );
}
