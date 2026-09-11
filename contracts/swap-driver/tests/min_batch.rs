//! The floor on a crank's batch, once the queue is deep.
//!
//! Only one transaction per block can drain a given queue. That makes the block's single drain
//! something worth taking: a crank funded for one request costs a fraction of a full one, consumes
//! the slot just as effectively, and leaves the queue moving one request per block for as long as
//! someone keeps it up. A pool's `min_crank_batch` closes that off: a crank owes whatever is
//! waiting, up to that many, so holding the slot costs about what clearing the queue costs. Here
//! the floor is `MIN_CRANK_BATCH`, set below the queue's ceiling so that both halves of the rule
//! are reachable.

mod common;
use common::*;

// Just enough to consume one entry and no more: one request's declared budget plus the epilogue
// reserve, a hair over the loop's own threshold.
const ONE_REQUEST_GAS: u64 = process_requests_gas(1) - REQUEST_GAS_MAX / 2;

// A crank that cannot fund what is waiting is refused -- and refused *before* the queue is touched,
// so it neither drains nor leaves anything half-done.
#[test]
fn a_starved_crank_is_refused_when_the_queue_is_deep() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        for _ in 0..MIN_CRANK_BATCH {
            enqueue(&etx)?;
        }
        etx.advance_block();

        let refused = try_crank_with(&etx, ONE_REQUEST_GAS)?;
        assert_eq!(
            refused.unwrap_err().try_as(),
            Some(SwapDriverError::BatchTooSmall)
        );

        // Nothing was taken: a crank that can afford the floor still finds the whole backlog
        // waiting.
        etx.advance_block();
        let (processed, _) = crank_with(&etx, process_requests_gas(MIN_CRANK_BATCH))?;
        assert_eq!(processed, MIN_CRANK_BATCH);

        Ok(())
    })
}

// The refusal does not cost anyone else the block: a real crank in the same block still lands,
// because an aborted frame's writes never reach reservation.
#[test]
fn a_refused_crank_does_not_take_the_blocks_drain() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        for _ in 0..MIN_CRANK_BATCH {
            enqueue(&etx)?;
        }
        etx.advance_block();

        crank_with(&etx, ONE_REQUEST_GAS).expect_err("too small to drain");

        // Same block, no `advance_block` between them.
        let (processed, _) = crank_with(&etx, process_requests_gas(MIN_CRANK_BATCH))?;
        assert_eq!(
            processed, MIN_CRANK_BATCH,
            "the starved crank should not have spent the block's drain"
        );

        Ok(())
    })
}

// The hole the depth-threshold form left: a queue parked just under the floor. A one-request crank
// is refused there too, because what it owes is what is waiting -- so an attacker cannot hold the
// queue at a shallow depth and drain it a request per block.
#[test]
fn a_starved_crank_is_refused_on_a_shallow_queue_too() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        for _ in 0..MIN_CRANK_BATCH - 1 {
            enqueue(&etx)?;
        }
        etx.advance_block();

        let refused = try_crank_with(&etx, ONE_REQUEST_GAS)?;
        assert_eq!(
            refused.unwrap_err().try_as(),
            Some(SwapDriverError::BatchTooSmall)
        );

        Ok(())
    })
}

// What stays cheap is the case worth keeping cheap: a crank owes only what is actually waiting, so
// a user hurrying its own lone request pays for one.
#[test]
fn a_crank_owes_only_what_is_waiting() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        enqueue(&etx)?;
        etx.advance_block();

        let (processed, _) = crank_with(&etx, ONE_REQUEST_GAS)?;
        assert_eq!(processed, 1);

        Ok(())
    })
}

// An empty queue owes nothing, so a crank that finds it empty is never refused -- it stays the free
// no-op it has always been.
#[test]
fn an_empty_queue_owes_nothing() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        let (processed, failed) = crank_with(&etx, ONE_REQUEST_GAS)?;
        assert_eq!((processed, failed), (0, 0));

        Ok(())
    })
}

// Declaring what the sizing helper advises clears the floor with room to spare, so a caller
// following the documented arithmetic is never caught out.
#[test]
fn the_advised_gas_for_the_floor_clears_the_floor() {
    assert!(process_requests_gas(MIN_CRANK_BATCH) > ONE_REQUEST_GAS);
    transact_assert_success(|| {
        let etx = setup_etx()?;

        for _ in 0..MIN_CRANK_BATCH {
            enqueue(&etx)?;
        }
        etx.advance_block();

        let (processed, _) = crank_with(&etx, process_requests_gas(MIN_CRANK_BATCH))?;
        assert_eq!(processed, MIN_CRANK_BATCH);

        Ok(())
    })
}

// The floor is a cap as well: past `MIN_CRANK_BATCH`, a crank owes that many however long the queue
// is. Otherwise a deep queue would price cranking out of reach exactly when it most needs draining.
#[test]
fn a_crank_never_owes_more_than_the_floor() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        // Fill the queue well past the floor.
        for _ in 0..MAX_QUEUE_LEN {
            enqueue(&etx)?;
        }
        etx.advance_block();

        // Funded for the floor, not for the backlog: accepted.
        let (processed, _) = crank_with(&etx, process_requests_gas(MIN_CRANK_BATCH))?;
        assert!(processed >= MIN_CRANK_BATCH);

        Ok(())
    })
}

/// //////////////////// helpers /////////////////////////////////////////////

fn enqueue(etx: &Etx) -> Result<RequestId, TransactResult> {
    let ctx = etx.ctx;
    // Enqueued as the router: the driver takes requests from it alone.
    etx.exec_tx(&ROUTER_ADDR, move || {
        ctx.driver().request(SwapRequest::swap_exact_in(
            ALICE.addr, UNIT_AMT, 0, 0, ALICE.addr,
        ))
    })
}

// As above, but catching a refusal so its type can be inspected.
#[allow(clippy::type_complexity)]
fn try_crank_with(etx: &Etx, gas: u64) -> Result<Result<(u32, u32), CallError>, TransactResult> {
    let ctx = etx.ctx;
    etx.exec_tx(&TEST_ADDR, || {
        ctx.driver().with_gas_limit(gas).try_process_requests()
    })
}

fn crank_with(etx: &Etx, gas: u64) -> Result<(u32, u32), TransactResult> {
    let ctx = etx.ctx;
    etx.exec_tx(&TEST_ADDR, || {
        ctx.driver().with_gas_limit(gas).process_requests()
    })
}
