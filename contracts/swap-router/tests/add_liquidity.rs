mod common;
use common::*;
use swap_pair::events::MintEvent;

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

// Alice funds the deposit, Bob is credited the LP tokens.  The two roles are
// distinct in `AddLiquidityRequest` (`purchaser`/`recipient`), and must stay
// distinct through the handler and `mint_lp` all the way to the `MintEvent`.
#[test]
fn add_liquidity_credits_a_recipient_other_than_the_purchaser() {
    let etx = setup_etx().expect("setup");
    let ctx = etx.ctx;

    // Establish reserves, so the add is priced against a live pool.
    etx.prime().expect("prime");

    let (amounts, _) = etx.user_balances(ALICE).expect("balances");
    etx.user_allow_for_pair(ALICE, amounts).expect("allow");
    etx.advance_block();

    let lp_of = |u: User| {
        etx.exec_user_tx(u, |_| ctx.lp().get_balance_of(u.addr))
            .expect("lp balance")
    };
    let (alice_before, bob_before) = (lp_of(ALICE), lp_of(BOB));

    // Alice submits, naming Bob as the recipient of the LP tokens.
    etx.exec_user_tx(ALICE, |_| {
        ctx.router().add_liquidity(
            &ctx.token_addrs[0],
            &ctx.token_addrs[1],
            amounts,
            [0, 0],
            BOB.addr,
        );
    })
    .expect("add_liquidity");
    etx.advance_block();

    let (r, counts) = etx.process_requests_capturing();
    assert_eq!(counts, (1, 0), "one request processed, none failed");

    // Exactly one MintEvent, naming both roles: Alice's deposit funded it
    // (topic 1), Bob was credited (topic 2).
    let sig = MintEvent::signature();
    let mints: Vec<_> = r
        .events()
        .iter()
        .filter(|e| EmittedEvent::from(*e).topic(0) == sig)
        .collect();
    assert_eq!(mints.len(), 1, "expected exactly one MintEvent");

    let mint = EmittedEvent::from(mints[0]);
    assert_eq!(mint.topic(1).expect("sender topic"), ALICE.addr.as_ref());
    assert_eq!(mint.topic(2).expect("receiver topic"), BOB.addr.as_ref());
    let minted = TypedEvent::<MintEvent>::new(mints[0])
        .payload()
        .amount_minted;
    assert!(minted > 0);

    // ...and the LP tokens really went to Bob, not Alice.
    etx.advance_block();
    assert_eq!(lp_of(ALICE), alice_before, "purchaser must not be credited");
    assert_eq!(
        lp_of(BOB),
        bob_before + minted,
        "recipient credited exactly what the event reported"
    );
}
