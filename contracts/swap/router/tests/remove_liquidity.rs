mod common;
use common::*;
use swap_pair::events::LiquidityBurnEvent;

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

// Alice burns her LP, Bob receives the underlying A/B tokens. The two roles are distinct in
// `RemoveLiquidityRequest` (`redeemer`/`recipient`), and must stay distinct through the handler and
// `burn_lp` to the `LiquidityBurnEvent`.
#[test]
fn remove_liquidity_pays_out_to_someone_other_than_the_redeemer() {
    let etx = setup_etx().expect("setup");
    let ctx = etx.ctx;

    // Prime the pool, then give Alice an LP position to remove.
    etx.prime().expect("prime");

    let (amounts, _) = etx.user_balances(ALICE).expect("balances");
    etx.user_allow_for_pair(ALICE, amounts).expect("allow");
    etx.advance_block();

    etx.user_add_liquidity(ALICE, amounts).expect("add");
    etx.process_outstanding_requests(1).expect("process add");
    etx.advance_block();

    let (_, liquidity) = etx.user_balances(ALICE).expect("balances");
    assert!(liquidity > 0);

    etx.user_allow_lp_for_pair(ALICE, liquidity)
        .expect("allow lp");
    etx.advance_block();

    let (bob_tokens_before, bob_lp_before) = etx.user_balances(BOB).expect("balances");

    // Alice submits, naming Bob as the recipient of the underlying tokens.
    etx.exec_user_tx(ALICE, |_| {
        ctx.router().remove_liquidity(
            &ctx.token_addrs[0],
            &ctx.token_addrs[1],
            liquidity,
            [0, 0],
            BOB.addr,
        );
    })
    .expect("remove_liquidity");
    etx.advance_block();

    let (r, counts) = etx.process_requests_capturing();
    assert_eq!(counts, (1, 0), "one request processed, none failed");

    // The liquidity burn names both roles: Alice's LP was burned (topic 1), Bob was paid the underlying
    // (topic 2).
    let burn = sole_event::<LiquidityBurnEvent>(&r);
    assert_eq!(burn.topic(1).expect("sender topic"), ALICE.addr.as_ref());
    assert_eq!(burn.topic(2).expect("recipient topic"), BOB.addr.as_ref());

    let redeemed = TypedEvent::<LiquidityBurnEvent>::new(burn.raw())
        .payload()
        .amounts_redeemed;
    assert!(redeemed[0] > 0 && redeemed[1] > 0);

    // ...and the underlying really went to Bob, while Alice's LP was spent.
    etx.advance_block();
    let (alice_tokens_after, alice_lp_after) = etx.user_balances(ALICE).expect("balances");
    let (bob_tokens_after, bob_lp_after) = etx.user_balances(BOB).expect("balances");

    assert_eq!(alice_lp_after, 0, "redeemer's LP was burned");
    assert_eq!(alice_tokens_after, [0, 0], "redeemer got no underlying");
    assert_eq!(bob_lp_after, bob_lp_before, "recipient's LP is untouched");
    assert_eq!(
        bob_tokens_after,
        balances_sum(bob_tokens_before, redeemed),
        "recipient paid exactly what the event reported"
    );
}
