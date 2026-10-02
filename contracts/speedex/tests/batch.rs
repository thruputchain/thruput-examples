//! The exchange end to end: offers escrowed in one block, cleared in the next, settled in any order.
//!
//! Every transaction reads the state its block began with, so the tests move on a block between
//! writing and reading: `Exchange::mint`, `close_and_clear` and `settle_all` each do so themselves.

mod common;
use common::*;

// For every asset, what the users hold plus what the exchange holds is what was minted. The
// exchange's holding -- escrow for unsettled offers and rounding dust -- is never negative.
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
        assert_eq!(b[bought as usize], 1000 * UNIT, "{b:?}");
    }
    assert_conserved(&x, [1000 * UNIT; N], &[&ALICE, &BOB, &CAROL]);
    // With no fee, only rounding dust could stay behind, and a symmetric ring leaves none.
    assert_eq!(x.pool(), [0; N]);
    assert_eq!(clearing.shortfall, 0);
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
        refused(A, B, engine::MIN_AMOUNT - 1, px(1.0)),
        SpeedexError::InvalidAmount
    );
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

#[test]
fn identical_offers_in_one_block_cannot_share_a_record() {
    // The mock environment gives every transaction the same source hash, so two identical
    // submissions by one user in one block would mint one id. The record is written under an
    // exclusive lock, so the second transaction is excluded from the block instead of escrowing
    // tokens under a record it cannot settle. (On a network, distinct transactions have distinct
    // hashes and both land.)
    let x = Exchange::setup();
    x.mint(&ALICE, A, 20 * UNIT);

    let first = x.submit(&ALICE, A, B, 10 * UNIT, px(1.0));
    let second = x.as_user(&ALICE, || {
        x.token(A).adjust_allowance(&x.addr, (10 * UNIT) as i128);
        x.client().submit_offer(A, B, 10 * UNIT, px(1.0))
    });
    assert!(second.is_err(), "the duplicate must not commit");

    x.advance_block();
    assert_eq!(x.balances(&ALICE), [10 * UNIT, 0, 0], "one escrow, not two");
    assert_eq!(x.offer(&first).unwrap().amount, 10 * UNIT);

    // Resubmitted in a later block, it is a distinct offer.
    let again = x.submit(&ALICE, A, B, 10 * UNIT, px(1.0));
    assert_ne!(again, first);
}

#[test]
fn a_grid_finer_than_the_engine_supports_is_refused_at_initialization() {
    hash_ident! { static OTHER_NONCE: SHA256Hash; }
    let x = Exchange::setup();
    let exchange_hash = *speedex::register_mock_contract(&x.env).as_hash();

    // Eight distinct addresses; `initialize` does not check that they are tokens.
    let mut assets = [ContractAddress::new([0; 32]); MAX_ASSETS];
    for (i, a) in assets.iter_mut().enumerate() {
        *a = ContractAddress::new([i as u8 + 1; 32]);
    }

    let (wide, tireless, narrow) = x
        .as_user(&TEST, || {
            let addr = deploy_contract(&OTHER_NONCE, &exchange_hash);
            let client = SpeedexClient::new(&addr);
            // 2^17 levels to the doubling is past the engine's finest; 2^16 is its finest.
            let wide = client.try_initialize(8, assets, 1, 2, 17, ROUNDS);
            let tireless = client.try_initialize(8, assets, 1, 1, 16, MAX_ROUNDS + 1);
            let narrow = client.try_initialize(8, assets, 1, 1, 16, MAX_ROUNDS);
            (wide, tireless, narrow)
        })
        .expect("deploy");
    assert_eq!(speedex_error(wide), SpeedexError::InvalidConfiguration);
    assert_eq!(speedex_error(tireless), SpeedexError::InvalidConfiguration);
    narrow.expect("the finest allowed grid");
}

#[test]
fn a_cleared_book_reports_its_fill_and_an_idle_one_none() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 100 * UNIT);
    x.mint(&BOB, B, 30 * UNIT);

    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 100 * UNIT, px(0.4));
    let bob = x.submit(&BOB, B, A, 30 * UNIT, px(1.0));
    let _ = x.close_and_clear(batch);

    let ab = x
        .as_user(&TEST, || x.client().book_fill(batch, A, B))
        .unwrap();
    let ba = x
        .as_user(&TEST, || x.client().book_fill(batch, B, A))
        .unwrap();
    let ac = x
        .as_user(&TEST, || x.client().book_fill(batch, A, C))
        .unwrap();
    assert!(ac.is_none(), "nothing was offered on A for C");
    let ba = ba.expect("Bob's book traded");
    assert!(ba.full_below >= 1 || ba.hi > 0, "{ba:?}");
    let ab = ab.expect("Alice's book traded");
    // Alice's single level is the marginal one: partially filled against Bob's 30 B.
    assert_eq!(ab.total, 100 * UNIT, "{ab:?}");
    assert!(ab.lo > 0 && ab.hi >= ab.lo && ab.hi <= ab.lo + 1, "{ab:?}");

    x.settle_all(&[alice, bob]);
    assert_conserved(&x, [100 * UNIT, 30 * UNIT, 0], &[&ALICE, &BOB]);
}

#[test]
fn a_clearing_must_be_told_every_occupied_cell() {
    let x = Exchange::setup();
    x.mint(&ALICE, A, 10 * UNIT);
    x.mint(&BOB, B, 10 * UNIT);

    let batch = x.current_batch();
    let alice = x.submit(&ALICE, A, B, 10 * UNIT, px(0.9));
    let bob = x.submit(&BOB, B, A, 10 * UNIT, px(0.9));
    x.advance_block();

    let full = x.cell_list(batch);
    assert_eq!(full.len(), 8, "two cells");

    // Leaving a cell out is refused: Bob's book would not add up.
    assert_eq!(
        speedex_error(x.try_clear_with(batch, &full[..4])),
        SpeedexError::BatchMismatch
    );
    // So is a list that is not strictly increasing, or not whole cells.
    let twice: Vec<u8> = [&full[..4], &full[..4], &full[4..]].concat();
    assert_eq!(
        speedex_error(x.try_clear_with(batch, &twice)),
        SpeedexError::InvalidCells
    );
    assert_eq!(
        speedex_error(x.try_clear_with(batch, &full[..7])),
        SpeedexError::InvalidCells
    );
    // A cell nobody used is harmless: it reads as empty.
    let stray = x
        .as_user(&TEST, || x.client().cell_of(C, A, 0))
        .unwrap()
        .to_le_bytes();
    let mut with_stray = full.clone();
    with_stray.extend_from_slice(&stray);
    let clearing = x.try_clear_with(batch, &with_stray).expect("clears");
    assert!(clearing.volume > 0);

    x.advance_block();
    x.settle_all(&[alice, bob]);
    assert_eq!(x.balances(&ALICE)[B as usize], 10 * UNIT);
    assert_eq!(x.balances(&BOB)[A as usize], 10 * UNIT);
}
