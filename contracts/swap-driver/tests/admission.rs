//! The ceiling on the driver's queue.
//!
//! The queue's storage is a deposit locked out of the driver's own HOG balance, so the driver holds
//! at most `max_queue_len` requests at a time. Reaching that ceiling makes further requests *wait*
//! rather than fail: their transactions are excluded from the block and returned to the mempool,
//! and they land once a `process_requests` has freed room.

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

// The request that would overrun the ceiling is deferred, not rejected: its frame ran to
// completion, and only the commit was held back -- which is what returns it to the mempool for a
// later block.
#[test]
fn a_request_past_the_ceiling_is_deferred() {
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
fn draining_frees_room_for_the_deferred_request() {
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
