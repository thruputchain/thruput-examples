//! The exchange end to end: offers escrowed in one block, cleared in the next, settled in any order.
//!
//! Every transaction reads the state its block began with, so the tests move on a block between
//! writing and reading: `Exchange::mint`, `close_and_clear` and `settle_all` each do so themselves.

mod common;
use common::*;

// For every asset, what the users hold plus what the exchange holds is what was minted. The
// exchange's holding -- escrow for unsettled offers, fees, rounding dust -- is never negative.
fn assert_conserved(x: &Exchange, minted: [u128; N], users: &[&ContractAddress]) {
    let pool = x.pool();
    for asset in 0..N {
        let held: u128 = users.iter().map(|u| x.balances(u)[asset]).sum();
        assert_eq!(held + pool[asset], minted[asset], "asset {asset}");
    }
}

#[test]
fn ring_trade_clears_through_three_assets() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 1000 * UNIT);
    x.mint(&BOB, B, 1000 * UNIT);
    x.mint(&CAROL, C, 1000 * UNIT);

    // Three offers, none with a counterparty on its own orderbook: Alice sells A for B, Bob B for C,
    // Carol C for A. All three land in the same block.
    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 1000 * UNIT, px(0.9));
    let bob = x.submit(&BOB, B, C, 1000 * UNIT, px(0.9));
    let carol = x.submit(&CAROL, C, A, 1000 * UNIT, px(0.9));

    let clearing = x.close_and_clear(batch);
    assert_eq!(x.pool(), [1000 * UNIT; N], "all in escrow until settled");
    assert!((ratio(&clearing, A, B) - 1.0).abs() < 0.02, "{clearing:?}");
    assert!((ratio(&clearing, B, C) - 1.0).abs() < 0.02, "{clearing:?}");
    // A symmetric ring clears at the equal prices tâtonnement starts from.
    assert_eq!(clearing.rounds, 0, "{clearing:?}");

    // Settlement is per offer, in any order, by anyone, any number to a block.
    x.settle_all(&[carol, alice, bob]);

    for (user, bought) in [(&ALICE, B), (&BOB, C), (&CAROL, A)] {
        let b = x.balances(user);
        assert!(b[bought as usize] >= 980 * UNIT, "{b:?}");
        assert!(b.iter().sum::<u128>() >= 980 * UNIT);
    }
    assert_conserved(&x, [1000 * UNIT; N], &[&ALICE, &BOB, &CAROL]);
    // What stays behind is the fee (one part in 1024) and rounding dust.
    assert!(
        x.pool().iter().all(|&kept| kept < 2 * UNIT),
        "{:?}",
        x.pool()
    );
}

#[test]
fn fees_accrue_per_batch_and_go_to_the_admin() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 1000 * UNIT);
    x.mint(&BOB, B, 1000 * UNIT);

    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 1000 * UNIT, px(0.9));
    let bob = x.submit(&BOB, B, A, 1000 * UNIT, px(0.9));
    let clearing = x.close_and_clear(batch);

    // The fee is one part in 1024 of each purchase, and is the exchange's as soon as the batch
    // clears -- before anyone settles.
    let fee = 1000 * UNIT / 1024;
    for asset in [A, B] {
        let s = clearing.surplus[asset as usize];
        assert!(s.abs_diff(fee) < fee / 20, "surplus {s} vs fee {fee}");
        assert_eq!(x.fees(asset), s);
    }

    assert_eq!(
        speedex_error(x.try_collect_fees(&BOB, A)),
        SpeedexError::Unauthorized
    );
    assert_eq!(
        speedex_error(x.try_collect_fees(&TEST, 3)),
        SpeedexError::InvalidAsset
    );
    let collected = x.try_collect_fees(&TEST, A).expect("collect");
    assert_eq!(collected, clearing.surplus[A as usize]);
    x.advance_block();
    assert_eq!(x.balances(&TEST)[A as usize], collected);
    assert_eq!(x.fees(A), 0);

    // Collecting first cannot short the offers: they settle in full afterwards.
    x.settle_all(&[alice, bob]);
    assert!(x.balances(&ALICE)[B as usize] >= 1000 * UNIT - 2 * fee);
    assert!(x.balances(&BOB)[A as usize] >= 1000 * UNIT - 2 * fee);
    assert_conserved(&x, [1000 * UNIT, 1000 * UNIT, 0], &[&ALICE, &BOB, &TEST]);
}

#[test]
fn two_sided_market_fills_both_sides() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 100 * UNIT);
    x.mint(&BOB, B, 50 * UNIT);

    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 100 * UNIT, px(0.4));
    let bob = x.submit(&BOB, B, A, 50 * UNIT, px(1.5));

    let clearing = x.close_and_clear(batch);
    assert!((ratio(&clearing, A, B) - 0.5).abs() < 0.02, "{clearing:?}");

    x.settle_all(&[alice, bob]);

    let alice_b = x.balances(&ALICE)[B as usize];
    let bob_a = x.balances(&BOB)[A as usize];
    assert!(
        alice_b.abs_diff(50 * UNIT) < 2 * UNIT,
        "Alice got {alice_b} B"
    );
    assert!(bob_a.abs_diff(100 * UNIT) < 3 * UNIT, "Bob got {bob_a} A");
    assert_conserved(&x, [100 * UNIT, 50 * UNIT, 0], &[&ALICE, &BOB]);
}

#[test]
fn a_binding_limit_fills_partially_and_refunds_the_rest() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 100 * UNIT);
    x.mint(&BOB, B, 30 * UNIT);

    // Alice wants at least 0.4 B per A -- which the grid rounds up to about 0.42 -- and Bob offers
    // only 30 B. Her limit binds: the 30 B buy about 71 A, at a ratio just above her level.
    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 100 * UNIT, px(0.4));
    let bob = x.submit(&BOB, B, A, 30 * UNIT, px(1.0));

    let clearing = x.close_and_clear(batch);
    let level = x.as_user(&TEST, || x.client().level_for(px(0.4))).unwrap();
    let limit =
        x.as_user(&TEST, || x.client().level_ratio(level)).unwrap() as f64 / PRICE_ONE as f64;
    assert!(limit > 0.4 && limit < 0.43, "grid level {limit}");
    let r = ratio(&clearing, A, B);
    assert!(r > limit && r < limit * 1.02, "{clearing:?}");

    x.settle_all(&[alice, bob]);

    let [alice_a, alice_b, _] = x.balances(&ALICE);
    let [bob_a, bob_b, _] = x.balances(&BOB);
    let expected_sold = (30.0 * UNIT as f64 / r) as u128;
    assert!(
        alice_a.abs_diff(100 * UNIT - expected_sold) < UNIT,
        "Alice keeps {alice_a} A"
    );
    assert!(
        alice_b.abs_diff(30 * UNIT) < UNIT / 2,
        "Alice got {alice_b} B"
    );
    assert!(bob_a.abs_diff(expected_sold) < UNIT, "Bob got {bob_a} A");
    assert!(bob_b < UNIT / 2, "Bob keeps {bob_b} B");

    // Alice's effective price is her limit or better.
    let sold = 100 * UNIT - alice_a;
    assert!(
        alice_b as f64 >= sold as f64 * limit - 2.0,
        "sold {sold} A for {alice_b} B"
    );
    assert_conserved(&x, [100 * UNIT, 30 * UNIT, 0], &[&ALICE, &BOB]);
}

#[test]
fn crossed_limits_refund_everything() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 10 * UNIT);
    x.mint(&BOB, B, 10 * UNIT);

    // Each side wants two of the other per unit; no ratio satisfies both.
    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 10 * UNIT, px(2.0));
    let bob = x.submit(&BOB, B, A, 10 * UNIT, px(2.0));

    let clearing = x.close_and_clear(batch);
    assert_eq!(clearing.volume, 0);
    assert_eq!(clearing.rounds, 0, "nothing can trade at any price");

    x.settle_all(&[alice, bob]);
    assert_eq!(x.balances(&ALICE), [10 * UNIT, 0, 0]);
    assert_eq!(x.balances(&BOB), [0, 10 * UNIT, 0]);
    assert_eq!(x.pool(), [0; N]);
}

#[test]
fn many_offers_in_one_block_commute_and_conserve() {
    let x = Exchange::setup();
    let users = [&ALICE, &BOB, &CAROL, &DAVE, &ERIN, &FRANK];

    // Six users, six directions, assorted limits and sizes -- all in one block.
    let offers: [(&ContractAddress, u32, u32, u128, f64); 6] = [
        (&ALICE, A, B, 300 * UNIT, 0.8),
        (&BOB, B, C, 120 * UNIT, 1.1),
        (&CAROL, C, A, 500 * UNIT, 0.5),
        (&DAVE, B, A, 90 * UNIT, 0.7),
        (&ERIN, A, C, 40 * UNIT, 1.9),
        (&FRANK, C, B, 260 * UNIT, 0.3),
    ];
    let mut minted = [0u128; N];
    for &(user, sell, _, amount, _) in &offers {
        x.mint(user, sell, amount);
        minted[sell as usize] += amount;
    }

    let batch = x.current_batch();
    let ids: Vec<OfferId> = offers
        .iter()
        .map(|&(user, sell, buy, amount, limit)| x.submit(user, sell, buy, amount, px(limit)))
        .collect();

    let clearing = x.close_and_clear(batch);
    assert_eq!(x.pool(), minted, "all in escrow");
    assert!(clearing.volume > 0);

    x.settle_all(&ids);

    for (&(user, sell, buy, amount, limit), id) in offers.iter().zip(&ids) {
        assert!(x.offer(id).is_none(), "settled offers are gone");
        let b = x.balances(user);
        let sold = amount - b[sell as usize];
        let bought = b[buy as usize];
        let r = ratio(&clearing, sell, buy);
        if sold > 0 {
            assert!(r > limit, "traded under limit: {r} < {limit}");
        }
        assert!(
            bought as f64 + 1.0 >= (sold as f64 - 2.0) * limit,
            "{sold} for {bought} at {limit}"
        );
    }
    assert_conserved(&x, minted, &users);
}

#[test]
fn a_batch_clears_once_after_it_closes_and_settles_only_then() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 10 * UNIT);

    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 10 * UNIT, px(1.0));

    // Still open.
    assert_eq!(speedex_error(x.try_clear(batch)), SpeedexError::BatchOpen);

    x.advance_block();
    assert!(x.offer(&alice).is_some());
    assert_eq!(
        speedex_error(x.try_settle(&alice)),
        SpeedexError::NotCleared
    );
    // Nothing was offered in the batch before Alice's.
    assert_eq!(
        speedex_error(x.try_clear(batch - 1)),
        SpeedexError::BatchEmpty
    );

    let _ = x.clear(batch);
    x.advance_block();
    assert_eq!(
        speedex_error(x.try_clear(batch)),
        SpeedexError::AlreadyCleared
    );
    assert!(
        x.as_user(&TEST, || x.client().clearing(batch))
            .unwrap()
            .is_some()
    );

    x.settle_all(&[alice]);
    assert_eq!(
        speedex_error(x.try_settle(&alice)),
        SpeedexError::NoSuchOffer
    );
    assert_eq!(
        x.balances(&ALICE),
        [10 * UNIT, 0, 0],
        "no counterparty: refunded"
    );
}

#[test]
fn an_open_offer_can_be_cancelled_by_its_owner_only() {
    // Three blocks to a batch, so an offer is still open in the block after it was made.
    let x = Exchange::setup_with(3);
    x.mint(&ALICE, A, 20 * UNIT);

    let batch = x.start_of_next_epoch();
    let alice = x.submit(&ALICE, A, B, 10 * UNIT, px(1.0));
    x.advance_block();
    assert_eq!(x.current_batch(), batch, "still open");
    assert_eq!(x.balances(&ALICE), [10 * UNIT, 0, 0], "half in escrow");

    assert_eq!(
        speedex_error(x.try_cancel(&BOB, &alice)),
        SpeedexError::Unauthorized
    );
    x.try_cancel(&ALICE, &alice).expect("cancel");
    x.advance_block();
    assert_eq!(x.balances(&ALICE), [20 * UNIT, 0, 0], "refunded");
    assert!(x.offer(&alice).is_none());
    assert_eq!(
        speedex_error(x.try_cancel(&ALICE, &alice)),
        SpeedexError::NoSuchOffer
    );

    // With the only offer withdrawn, the batch holds nothing.
    let next = x.start_of_next_epoch();
    assert_eq!(speedex_error(x.try_clear(batch)), SpeedexError::BatchEmpty);

    // Once its batch has closed, an offer is committed to it.
    let again = x.submit(&ALICE, A, B, 10 * UNIT, px(1.0));
    x.start_of_next_epoch();
    assert_eq!(
        speedex_error(x.try_cancel(&ALICE, &again)),
        SpeedexError::BatchClosed
    );
    assert_eq!(x.clear(next).volume, 0);
}

#[test]
fn malformed_offers_are_refused() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 10 * UNIT);

    let refused = |sell, buy, amount, min_price| {
        speedex_error(x.try_submit(&ALICE, sell, buy, amount, min_price))
    };
    assert_eq!(refused(A, A, UNIT, px(1.0)), SpeedexError::InvalidAsset);
    assert_eq!(refused(A, 3, UNIT, px(1.0)), SpeedexError::InvalidAsset);
    assert_eq!(refused(A, B, 0, px(1.0)), SpeedexError::InvalidAmount);
    assert_eq!(
        refused(A, B, engine::MAX_AMOUNT, px(1.0)),
        SpeedexError::InvalidAmount
    );
    assert_eq!(refused(A, B, UNIT, 0), SpeedexError::InvalidPrice);
    // Above the top of a two-octave grid.
    assert_eq!(refused(A, B, UNIT, px(4.0)), SpeedexError::InvalidPrice);

    // Nothing was taken.
    x.advance_block();
    assert_eq!(x.balances(&ALICE), [10 * UNIT, 0, 0]);
}

#[test]
fn an_epoch_groups_several_blocks_into_one_batch() {
    let x = Exchange::setup_with(4);
    x.mint(&ALICE, A, 10 * UNIT);
    x.mint(&BOB, B, 10 * UNIT);

    let batch = x.start_of_next_epoch();
    let alice = x.submit(&ALICE, A, B, 10 * UNIT, px(0.9));
    x.advance_block();
    assert_eq!(x.current_batch(), batch, "still the same epoch");
    let bob = x.submit(&BOB, B, A, 10 * UNIT, px(0.9));
    x.advance_block();
    assert_eq!(x.offer(&bob).unwrap().batch, batch);
    assert_eq!(x.offer(&alice).unwrap().batch, batch);

    let clearing = x.close_and_clear(batch);
    assert!((ratio(&clearing, A, B) - 1.0).abs() < 0.02);

    x.settle_all(&[alice, bob]);
    assert!(x.balances(&ALICE)[B as usize] >= 9 * UNIT);
    assert!(x.balances(&BOB)[A as usize] >= 9 * UNIT);
}
