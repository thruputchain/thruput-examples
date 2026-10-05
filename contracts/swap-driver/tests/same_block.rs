//! What can share a block with a crank.
//!
//! Every transaction in a block executes against the state the previous block committed, and the
//! block's writes are then merged: blind deltas (an `NNInt` increment, an `RCQ` insert) add up,
//! while two transactions that set one `Value` differently cannot both be included -- the loser is
//! returned to the mempool. A pool's reserves are one such `Value`, and the crank is the
//! transaction that has to be able to write them. These tests pin down what else may land beside
//! it, and what happens to a user's own transactions when they race the crank that handles their
//! request.

mod common;
use common::*;

// What Alice swaps in each test.
const SWAP_IN_AMT: Amount = 2 * UNIT_AMT;

/////////////////////// sync and skim ///////////////////////////////////////

// A `sync` that finds nothing to record writes nothing, so it cannot conflict with the crank -- in
// either order. Without this, anyone could take the block's one drain away from the crank for the
// price of an empty `sync`.
#[test]
fn an_idle_sync_shares_a_block_with_the_crank() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        alice_requests_a_swap(&etx)?;
        etx.advance_block();

        // Crank first, then the idle sync.
        assert_eq!(etx.process_requests()?, (1, 0));
        let sync = sync_tx(&etx);
        sync.assert_success();
        assert_eq!(storage_writes(&sync), 0, "an idle sync writes no delta");
        sync.assert_no_events();

        etx.advance_block();

        // And the other way round.
        alice_requests_a_swap(&etx)?;
        etx.advance_block();

        sync_tx(&etx).assert_success();
        assert_eq!(etx.process_requests()?, (1, 0));

        Ok(())
    })
}

// So does a `skim` with no surplus to send.
#[test]
fn an_idle_skim_shares_a_block_with_the_crank() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        alice_requests_a_swap(&etx)?;
        etx.advance_block();

        assert_eq!(etx.process_requests()?, (1, 0));
        let skim = skim_tx(&etx);
        skim.assert_success();
        assert_eq!(storage_writes(&skim), 0, "an idle skim writes no delta");

        Ok(())
    })
}

// A `sync` that does have something to record -- here, a donation the reserves have not caught up
// with -- writes the reserves, and so conflicts with a crank in the same block. One of the two is
// excluded; here the crank landed first, so the sync is what returns to the mempool. The donation
// is still accounted for: the crank's own reserve update saw it.
#[test]
fn a_sync_with_something_to_record_conflicts_with_the_crank() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = etx.ctx;

        alice_requests_a_swap(&etx)?;
        // Bob sends tokens straight to the pool, unrecorded.
        etx.exec_user_tx(BOB, |_| {
            ctx.token0()
                .transfer(&ctx.request_handler_addr, to_token(UNIT_AMT));
        })?;
        etx.advance_block();

        assert_eq!(etx.process_requests()?, (1, 0));
        sync_tx(&etx).assert_commit_failed_nondeterministically();

        etx.advance_block();

        // Nothing is left for a sync to record: the crank recorded the balances as it found them,
        // donation included.
        let sync = sync_tx(&etx);
        sync.assert_success();
        assert_eq!(storage_writes(&sync), 0);

        Ok(())
    })
}

/////////////////////// a user racing the crank /////////////////////////////

// Alice's request is queued; in the block that drains it she moves her whole balance away. The
// handler's call is commit-locked, so the request fails on its own -- Alice's transfer and the
// crank both land, and the pool is untouched by the failed request. Order within the block: the
// transfer first.
#[test]
fn a_same_block_withdrawal_fails_only_its_own_request() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = etx.ctx;

        let id = alice_requests_a_swap(&etx)?;
        etx.advance_block();

        let reserves_before = etx.reserves()?;
        let (alice_before, _) = etx.user_balances(ALICE)?;
        let (bob_before, _) = etx.user_balances(BOB)?;

        // Alice moves everything to Bob ...
        etx.exec_user_tx(ALICE, |_| {
            let all = from_token(ctx.token0().get_balance());
            ctx.token0().transfer(BOB.addr, to_token(all));
        })?;

        // ... and, in the same block, the crank handles her request.
        let (crank, counts) = crank_capturing(&etx);
        crank.assert_success();
        assert_eq!(counts, (1, 1), "one request handled, and it failed");
        assert_eq!(request_failed_ids(&crank), vec![id]);

        etx.advance_block();

        let (alice_after, _) = etx.user_balances(ALICE)?;
        let (bob_after, _) = etx.user_balances(BOB)?;
        assert_eq!(alice_after[0], 0, "Alice's transfer landed");
        assert_eq!(bob_after[0], bob_before[0] + alice_before[0]);
        assert_eq!(etx.reserves()?, reserves_before, "the pool saw nothing");

        Ok(())
    })
}

// The same race, with the crank landing first: the request is handled against the balance the block
// began with, and it is Alice's transfer that no longer fits -- her frame succeeds (it too read the
// block's snapshot), but the merged debits overdraw the balance, so her transaction is excluded and
// returned to the mempool. Retried next block, it is refused outright.
#[test]
fn a_crank_that_lands_first_excludes_the_conflicting_withdrawal() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = etx.ctx;

        alice_requests_a_swap(&etx)?;
        etx.advance_block();

        let (alice_before, _) = etx.user_balances(ALICE)?;
        let all = alice_before[0];

        assert_eq!(etx.process_requests()?, (1, 0));

        let withdrawal = etx
            .exec_user_tx(ALICE, move |_| {
                ctx.token0().transfer(BOB.addr, to_token(all));
            })
            .expect_err("overdraws once merged with the crank's debit");
        withdrawal.assert_commit_failed_nondeterministically();

        etx.advance_block();

        // Now the balance the block begins with is short, and the same transfer fails at call time.
        let refused = etx
            .exec_user_tx(ALICE, move |_| {
                ctx.token0().transfer(BOB.addr, to_token(all));
            })
            .expect_err("the balance is short");
        refused.assert_abort();

        let (alice_after, _) = etx.user_balances(ALICE)?;
        assert_eq!(alice_after[0], all - SWAP_IN_AMT, "the swap went through");

        Ok(())
    })
}

// Admission is irrevocable, but a queued request can still be starved: the handler spends the
// user's standing allowance, and revoking it makes the request fail when handled. Everyone else's
// requests in the batch are unaffected.
#[test]
fn revoking_the_allowance_starves_a_queued_request() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = etx.ctx;

        let alice_id = alice_requests_a_swap(&etx)?;
        let carol_id = user_requests_a_swap(&etx, CAROL)?;
        etx.advance_block();

        // Alice thinks better of it.
        etx.exec_user_tx(ALICE, |_| {
            ctx.token0()
                .adjust_allowance(&ctx.request_handler_addr, -(SWAP_IN_AMT as i128));
        })?;

        let (crank, counts) = crank_capturing(&etx);
        crank.assert_success();
        assert_eq!(counts, (2, 1));
        assert_eq!(request_failed_ids(&crank), vec![alice_id]);
        assert_eq!(swap_request_ids(&crank), vec![Some(carol_id)]);

        Ok(())
    })
}

/////////////////////// helpers /////////////////////////////////////////////

// `user` allows the handler `SWAP_IN_AMT` of token0 and, as the router, enqueues a swap of that
// much for token1. Returns the request's id.
fn user_requests_a_swap(etx: &Etx, user: User) -> Result<RequestId> {
    let ctx = etx.ctx;

    etx.exec_user_tx(user, |_| {
        ctx.token0()
            .adjust_allowance(&ctx.request_handler_addr, SWAP_IN_AMT as i128);
    })?;

    etx.exec_tx(&ROUTER_ADDR, move || {
        ctx.driver().request(SwapRequest::swap_exact_in(
            user.addr,
            SWAP_IN_AMT,
            0,
            0,
            user.addr,
        ))
    })
}

fn alice_requests_a_swap(etx: &Etx) -> Result<RequestId> {
    user_requests_a_swap(etx, ALICE)
}

fn sync_tx(etx: &Etx) -> TransactResult {
    let ctx = etx.ctx;
    etx.env
        .transact(|tx| tx.call(&TEST_ADDR).run(move || ctx.handler().sync()))
}

fn skim_tx(etx: &Etx) -> TransactResult {
    let ctx = etx.ctx;
    etx.env.transact(|tx| {
        tx.call(&TEST_ADDR)
            .run(move || ctx.handler().skim(&TEST_ADDR))
    })
}

// Crank as TEST_ADDR, returning the whole transaction result alongside the `(processed, failed)`
// counts so the batch's events can be inspected.
fn crank_capturing(etx: &Etx) -> (TransactResult, (u32, u32)) {
    use std::sync::{Arc, Mutex};

    let ctx = etx.ctx;
    let counts = Arc::new(Mutex::new((0u32, 0u32)));

    let r = etx.env.transact(|tx| {
        tx.call(&TEST_ADDR).run(|| {
            let c = ctx
                .driver()
                .with_gas_limit(process_requests_gas(10))
                .process_requests();
            *Arc::clone(&counts).lock().unwrap() = c;
        })
    });

    let counts = Arc::into_inner(counts).unwrap().into_inner().unwrap();
    (r, counts)
}

impl Etx {
    fn reserves(&self) -> Result<Amounts> {
        let ctx = self.ctx;
        self.exec_tx(&TEST_ADDR, move || ctx.pair().pool_state().reserves)
    }
}

fn storage_writes(result: &TransactResult) -> usize {
    result
        .frame()
        .trace()
        .expect("the mock environment traces every frame")
        .storage_writes
        .len()
}

// The ids carried by the `RequestFailed` events a transaction emitted.
fn request_failed_ids(r: &TransactResult) -> Vec<RequestId> {
    let sig = RequestFailed::signature();
    r.events()
        .iter()
        .filter_map(|e| {
            let e = EmittedEvent::from(e);
            (e.topic(0) == sig).then(|| RequestId::new(*e.topic(1).expect("request_id topic")))
        })
        .collect()
}

// The ids carried by the `SwapEvent`s a transaction emitted.
fn swap_request_ids(r: &TransactResult) -> Vec<Option<RequestId>> {
    use swap_pair::events::SwapEvent;

    let sig = SwapEvent::signature();
    r.events()
        .iter()
        .filter(|e| EmittedEvent::from(*e).topic(0) == sig)
        .map(|e| TypedEvent::<SwapEvent>::new(e).payload().request_id)
        .collect()
}
