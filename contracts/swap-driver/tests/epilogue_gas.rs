//! Calibration for [`batch_driver::EPILOGUE_GAS`] against the guest build.
//!
//! `process` checks that the frame holds `REQUEST_GAS_MAX + EPILOGUE_GAS` before it takes a
//! request. Handling that request can spend the whole `REQUEST_GAS_MAX` (the sub-call is capped
//! there, and unused child gas comes back), which leaves `EPILOGUE_GAS` less that one iteration's
//! own overhead. Whatever remains has to pay for the loop's closing check, the driver's
//! `slots.release` and `RequestsProcessed`, and the return. If it cannot, the frame faults and the
//! entire batch is lost -- so `EPILOGUE_GAS` has to be a real over-estimate of the driver's
//! non-handler cost, not a round number.
//!
//! Gas is only metered for real in the guest build, so this is `guest_test` only. It measures the
//! driver's cost with the handler's own consumption subtracted out, and holds `EPILOGUE_GAS` above
//! it.

#![cfg(feature = "guest_test")]

mod common;
use common::*;

use groundhog_trace::transaction_trace::SyscallTraceBody;

const SWAP_IN_AMT: Amount = 2 * UNIT_AMT;

// How much room over the measured cost the constant should keep. The measurement is one shape of
// request on one build; the constant has to cover the others too.
const MARGIN: u64 = 3;

// What a crank costs, by batch size, measured in the guest.
struct Costs {
    empty: u64,
    fixed: u64,
    marginal: u64,
}

fn measure(etx: &Etx) -> Costs {
    // A crank that finds nothing: entering the frame, one budget check, the probe that finds the
    // queue empty, and returning. It does no tail work, because a batch that took nothing touches
    // nothing.
    let empty = measure_crank(etx, 0);

    // Batches of one and two. The difference is one request's marginal cost (its handling, plus
    // consuming and decoding it); the rest is what a crank costs whatever its size -- including the
    // tail that only a non-empty batch performs.
    let one = measure_crank(etx, 1);
    let two = measure_crank(etx, 2);
    let marginal = two - one;

    Costs {
        empty,
        fixed: one - marginal,
        marginal,
    }
}

#[test]
fn epilogue_gas_covers_the_drivers_own_cost() {
    let etx = setup_etx_primed().expect("setup");
    let c = measure(&etx);

    println!("empty crank        : {}", c.empty);
    println!("fixed, per crank   : {}", c.fixed);
    println!("marginal, per req  : {}", c.marginal);
    println!("EPILOGUE_GAS       : {}", batch_driver::EPILOGUE_GAS);
    println!(
        "margin over fixed  : {:.1}x",
        batch_driver::EPILOGUE_GAS as f64 / c.fixed as f64
    );

    // `fixed` is everything a crank spends that is not per-request: the frame entry and its closing
    // check, and -- the part that matters here -- the `slots.release` and `RequestsProcessed` that
    // run after the last request, on whatever gas the reserve left behind. It over-counts the
    // reserve's job by the frame entry, and under-counts it by one iteration's own consume and
    // decode, which cannot be separated from the handler's consumption in the marginal figure. The
    // margin is what covers that gap, other request shapes, and a build that shifts the numbers.
    assert!(
        batch_driver::EPILOGUE_GAS >= c.fixed * MARGIN,
        "EPILOGUE_GAS ({}) should stay at least {MARGIN}x a crank's measured \
         fixed cost ({})",
        batch_driver::EPILOGUE_GAS,
        c.fixed,
    );

    // The reserve also has to be worth more than a crank that does nothing at all, which is the
    // same work minus the tail.
    assert!(batch_driver::EPILOGUE_GAS > c.empty);
}

// For the record: the declared per-request budget against the real one.
#[test]
fn report_declared_versus_real_request_cost() {
    let etx = setup_etx_primed().expect("setup");
    let c = measure(&etx);

    println!("marginal, per swap : {}", c.marginal);
    println!("REQUEST_GAS_MAX    : {REQUEST_GAS_MAX}");
    println!(
        "declared/real      : {:.1}x",
        REQUEST_GAS_MAX as f64 / c.marginal as f64
    );
}

/// //////////////////// measurement /////////////////////////////////////////

// Gas spent inside the frame `address` was invoked in, taken from the calling frame's Invoke
// syscall.
fn invoke_cost(r: &TransactResult, address: &Address) -> u64 {
    let trace = r.frame().trace().expect("traced");
    let mut costs = trace.system_calls.iter().filter_map(|c| match &c.body {
        SyscallTraceBody::kInvoke { invoke } if &invoke.inputs.address == address => {
            Some(c.gas_remaining_at_start - c.gas_remaining_at_end)
        }
        _ => None,
    });
    let cost = costs.next().expect("an invoke of that address");
    assert!(costs.next().is_none(), "expected exactly one invoke");
    cost
}

// Queue `n` swaps that will succeed, crank them, and report what the driver's frame spent.
fn measure_crank(etx: &Etx, n: u32) -> u64 {
    let ctx = etx.ctx;

    for _ in 0..n {
        pledge_and_request(etx);
    }
    etx.advance_block();

    let r = etx.env.transact(|tx| {
        tx.call(&TEST_ADDR).run(|| {
            let counts = ctx
                .driver()
                .with_gas_limit(process_requests_gas(10))
                .process_requests();
            assert_eq!(counts.1, 0, "requests should succeed");
            assert_eq!(counts.0, n, "the whole batch should drain");
        })
    });
    r.assert_success();

    invoke_cost(&r, &ctx.driver_addr)
}

fn pledge(etx: &Etx, user: User) {
    let ctx = etx.ctx;
    etx.exec_user_tx(user, |_| {
        ctx.token0()
            .adjust_allowance(&ctx.request_handler_addr, SWAP_IN_AMT as i128)
    })
    .expect("pledge");
}

fn pledge_and_request(etx: &Etx) {
    let ctx = etx.ctx;
    pledge(etx, ALICE);
    etx.advance_block();
    etx.exec_tx(&ROUTER_ADDR, move || {
        ctx.driver().request(swap_request(&ALICE))
    })
    .expect("request");
}

fn swap_request(u: &User) -> SwapRequest {
    SwapRequest::swap_exact_in(u.addr, SWAP_IN_AMT, 0, 0, u.addr)
}
