//! Only the router may enqueue, and only the driver may have a request handled.
//!
//! A `SwapRequest` names the account whose tokens it will spend, and the
//! handler spends them on that account's standing allowance to it. Neither the
//! driver nor the handler can check that claim -- the router is what sees the
//! account making the call -- so each link accepts work from its predecessor
//! alone. Without that, anyone could enqueue a request naming a victim as the
//! sender and themselves as the recipient, and be paid out of the victim's
//! approval.

mod common;
use common::*;

// Anyone who is not the router is refused, whatever the request names.
#[test]
fn enqueueing_is_refused_from_anyone_but_the_router() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        let ctx = etx.ctx;

        for pretender in [ALICE, BOB, TEST, FACTORY] {
            let refused = etx.exec_tx(pretender.addr, move || {
                // Naming the victim as the payer and the caller as recipient:
                // the shape the check exists to stop.
                ctx.driver().try_request(SwapRequest::swap_exact_in(
                    CAROL.addr,
                    UNIT_AMT,
                    0,
                    0,
                    pretender.addr,
                ))
            })?;

            assert_eq!(
                refused.unwrap_err().try_as(),
                Some(SwapDriverError::Unauthorized),
            );
        }

        Ok(())
    })
}

// And the queue can still be bypassed by nobody: the handler takes requests
// from its driver alone.
#[test]
fn handling_is_refused_from_anyone_but_the_driver() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        let ctx = etx.ctx;

        for pretender in [ALICE, ROUTER_ADDR_USER, TEST, FACTORY] {
            let refused = etx.exec_tx(pretender.addr, move || {
                ctx.handler().try_handle_request(SwapRequest::swap_exact_in(
                    CAROL.addr,
                    UNIT_AMT,
                    0,
                    0,
                    pretender.addr,
                ))
            })?;

            assert_eq!(
                refused.unwrap_err().try_as(),
                Some(SwapRequestError::Unauthorized),
            );
        }

        Ok(())
    })
}

// The router's own requests still go through, so the guard admits what it
// should.
#[test]
fn the_router_may_still_enqueue() {
    transact_assert_success(|| {
        let etx = setup_etx()?;
        let ctx = etx.ctx;

        etx.exec_tx(&ROUTER_ADDR, move || {
            ctx.driver().request(SwapRequest::swap_exact_in(
                ALICE.addr, UNIT_AMT, 0, 0, ALICE.addr,
            ))
        })?;

        Ok(())
    })
}
