//! The ceiling on the driver's queue.
//!
//! The queue's storage is a deposit locked out of the driver's own native-token balance, so the
//! driver holds at most `max_queue_len` requests at a time. Past that ceiling, a request's
//! transaction fails at commit rather than in its frame: it is left out of the block with nothing
//! written, and can be submitted again, as it is, once a `process_requests` has freed room. (The
//! node does not retry it by itself.)

mod common;
use common::*;

// Filling the queue to the ceiling is ordinary business, even with every request arriving in the
// same block.
#[test]
fn requests_up_to_the_ceiling_are_accepted() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        for i in 0..MAX_QUEUE_LEN {
            enqueue(&etx, i).expect("within the ceiling");
        }

        Ok(())
    })
}

// The request that would overrun the ceiling is not rejected by the contract: its frame ran to
// completion, and only the commit failed -- which leaves it out of the block rather than including
// it as a failure.
#[test]
fn a_request_past_the_ceiling_fails_at_commit() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        for i in 0..MAX_QUEUE_LEN {
            enqueue(&etx, i).expect("within the ceiling");
        }

        let overrun = enqueue(&etx, MAX_QUEUE_LEN).expect_err("past the ceiling");
        overrun.frame().assert_success();
        overrun.assert_commit_failed_nondeterministically();

        Ok(())
    })
}

// Draining returns the room, including the room of requests whose handling failed -- they left the
// queue just the same. (Nothing here is funded, so every one of them fails.)
#[test]
fn draining_frees_room_for_a_refused_request() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        for i in 0..MAX_QUEUE_LEN {
            enqueue(&etx, i).expect("within the ceiling");
        }
        enqueue(&etx, MAX_QUEUE_LEN).expect_err("past the ceiling");

        etx.advance_block();

        let (n_processed, n_failed) = etx.process_requests()?;
        assert_eq!(n_processed, MAX_QUEUE_LEN);
        assert_eq!(n_failed, MAX_QUEUE_LEN, "unfunded requests all fail");

        etx.advance_block();

        // The whole ceiling's worth of room is back.
        for i in 0..MAX_QUEUE_LEN {
            enqueue(&etx, i).expect("room was returned");
        }

        Ok(())
    })
}

// Enqueue a swap request as ALICE. Nothing here is funded: these requests are only ever meant to
// occupy the queue, and to fail if they are handled.
fn enqueue(etx: &Etx, nth: u32) -> Result<RequestId, TransactResult> {
    let ctx = &etx.ctx;

    // Enqueued as the router: the driver takes requests from it alone.
    etx.exec_tx(&ROUTER_ADDR, move || {
        ctx.driver().request(SwapRequest::swap_exact_in(
            ALICE.addr,
            UNIT_AMT + u128::from(nth),
            0,
            0,
            ALICE.addr,
        ))
    })
}
