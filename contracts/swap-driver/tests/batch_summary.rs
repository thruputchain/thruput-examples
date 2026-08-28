//! The `RequestsProcessed` summary a crank emits.
//!
//! `process_requests` returns its counts to whoever called it, but an observer
//! following only the event stream sees nothing of the return value.  The
//! summary is for them: the queue's depth is the `RequestAccepted`s seen, less
//! the `processed` these report.

mod common;
use common::*;

const SWAP_IN_AMT: Amount = 2 * UNIT_AMT;

// A batch reports what it took out of the queue, failures included.  Nothing
// here is funded, so every request fails -- and is still processed.
#[test]
fn a_batch_reports_failures_as_processed() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        let ctx = &etx.ctx;

        for _ in 0..3 {
            enqueue_unfunded(&etx)?;
        }
        etx.advance_block();

        let (r, counts) = process_capturing(&etx);
        assert_eq!(counts, (3, 3), "processed, all failing");
        assert_eq!(summaries_from(&r, &ctx.driver_addr), vec![(3, 3)]);

        Ok(())
    })
}

// A batch that succeeded reports no failures.
#[test]
fn a_successful_batch_reports_no_failures() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let ctx = &etx.ctx;

        // Let the handler pull each trader's input funds.
        for user in [ALICE, BOB] {
            etx.exec_user_tx(user, |_| {
                ctx.token0()
                    .adjust_allowance(&ctx.request_handler_addr, SWAP_IN_AMT as i128)
            })?;
        }
        etx.advance_block();

        for user in [ALICE, BOB] {
            // Enqueued as the router: the driver takes requests from it alone.
            etx.exec_tx(&ROUTER_ADDR, move || {
                ctx.driver().request(SwapRequest::swap_exact_in(
                    user.addr,
                    SWAP_IN_AMT,
                    0,
                    0,
                    user.addr,
                ))
            })?;
        }

        let (r, counts) = process_capturing(&etx);
        assert_eq!(counts, (2, 0), "both processed, neither failing");
        assert_eq!(summaries_from(&r, &ctx.driver_addr), vec![(2, 0)]);

        Ok(())
    })
}

// A crank that finds the queue empty reports nothing at all -- there is no
// work to describe, and silence keeps such a crank as free as it already is.
#[test]
fn an_empty_batch_reports_nothing() {
    transact_assert_success(|| {
        let etx = setup_etx()?;

        let (r, counts) = process_capturing(&etx);
        assert_eq!(counts, (0, 0));
        assert_eq!(summaries_from(&r, &etx.ctx.driver_addr), vec![]);
        r.frame().assert_no_events();

        // Nothing was taken, so nothing is written: not even the room that a
        // batch of zero would give back.  This is what keeps a crank that
        // loses, or finds nothing, from conflicting with anyone.
        assert_eq!(
            r.frame().trace().expect("traced").storage_writes.len(),
            0,
            "an empty batch writes no storage delta"
        );

        Ok(())
    })
}

// The summary is attributed to the driver that emitted it.  With one driver
// per pair, that address is what tells an observer which pair a batch belongs
// to -- so the event carries no identifier of its own, and an observer
// following several pairs filters by contract address (the RPC event filter
// takes one) rather than by a topic.
#[test]
fn the_summary_identifies_its_driver_by_the_emitting_address() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        let ctx = &etx.ctx;

        enqueue_unfunded(&etx)?;
        etx.advance_block();

        let (r, _) = process_capturing(&etx);

        assert_eq!(summaries_from(&r, &ctx.driver_addr), vec![(1, 1)]);
        {
            let other = &ctx.request_handler_addr;
            assert_eq!(
                summaries_from(&r, other),
                vec![],
                "the summary belongs to the driver alone"
            );
        }

        Ok(())
    })
}

/////////////////////// helpers /////////////////////////////////////////////

// The (processed, failed) pairs carried by the `RequestsProcessed` events that
// `address` emitted.
fn summaries_from(r: &TransactResult, address: &Address) -> Vec<(u32, u32)> {
    r.frame()
        .filter_events::<RequestsProcessed>(address)
        .iter()
        .map(|e| (e.payload().processed, e.payload().failed))
        .collect()
}

fn enqueue_unfunded(etx: &Etx) -> Result<RequestId, TransactResult> {
    let ctx = etx.ctx;

    // Enqueued as the router: the driver takes requests from it alone.
    etx.exec_tx(&ROUTER_ADDR, move || {
        ctx.driver().request(SwapRequest::swap_exact_in(
            ALICE.addr, UNIT_AMT, 0, 0, ALICE.addr,
        ))
    })
}

// Run `process_requests` as TEST_ADDR, returning the whole tx result (so its
// events can be inspected) alongside the `(processed, failed)` counts.
fn process_capturing(etx: &Etx) -> (TransactResult, (u32, u32)) {
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
