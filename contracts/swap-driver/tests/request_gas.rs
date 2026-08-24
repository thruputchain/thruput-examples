//! Calibration for the per-request gas budgets in `swap-if`.
//!
//! Each `SwapRequest` declares what its handling may cost, and the driver caps
//! the handler sub-call there.  The declaration is a safety limit, so it has to
//! sit above the real cost with room -- a request that outruns its budget does
//! not slow down, it *fails*.  But the margin is not free either: the loop
//! budgets `REQUEST_GAS_MAX` per request before taking one, so an inflated
//! figure makes every crank declare more gas than it needs, and pushes up the
//! floor a crank must clear before it may drain at all.
//!
//! Gas is only metered for real in the guest build, so this is `guest_test`
//! only.  It measures each operation as the driver invokes it -- one
//! `handle_request` call -- and holds each declared budget above what it costs.

#![cfg(feature = "guest_test")]

mod common;
use common::*;

use groundhog_trace::transaction_trace::SyscallTraceBody;
use swap_if::{ADD_LIQUIDITY_GAS, REMOVE_LIQUIDITY_GAS, SWAP_GAS};

// How much room each declared budget should keep over the measured cost.
//
// Generous on purpose.  These measurements cover one shape of each operation
// against one pool state, and the costs vary with the path taken: notably, the
// protocol-fee branch in the pair's `mint_fee` -- a square root and some U256
// arithmetic on every liquidity event -- is unreachable here, because nothing
// in these tests configures a `fee_to`.  The margin is what stands in for the
// paths the measurement does not reach.
const MARGIN: u64 = 2;

#[test]
fn declared_request_budgets_cover_what_handling_costs() {
    let etx = setup_etx_primed().expect("setup");

    let measured = [
        ("swap_exact_in", SWAP_GAS, measure_swap_exact_in(&etx)),
        ("swap_exact_out", SWAP_GAS, measure_swap_exact_out(&etx)),
        (
            "add_liquidity",
            ADD_LIQUIDITY_GAS,
            measure_add_liquidity(&etx),
        ),
        (
            "remove_liquidity",
            REMOVE_LIQUIDITY_GAS,
            measure_remove_liquidity(&etx),
        ),
    ];

    for (name, declared, cost) in measured {
        println!(
            "{name:17} cost {cost:>7}  declared {declared:>7}  ({:.1}x)",
            declared as f64 / cost as f64
        );
    }
    println!("REQUEST_GAS_MAX declared: {REQUEST_GAS_MAX}");

    for (name, declared, cost) in measured {
        assert!(
            declared >= cost * MARGIN,
            "{name} declares {declared}, only {:.1}x its measured {cost}; \
             wanted at least {MARGIN}x",
            declared as f64 / cost as f64,
        );
    }

    // The batch budget has to bound every one of them, since the drain loop
    // checks against it without knowing which request comes next.
    let worst = measured
        .iter()
        .map(|(_, declared, _)| *declared)
        .max()
        .unwrap();
    assert_eq!(
        REQUEST_GAS_MAX, worst,
        "REQUEST_GAS_MAX should be the largest"
    );
}

/////////////////////// measurement /////////////////////////////////////////

fn handler_cost(r: &TransactResult, address: &Address) -> u64 {
    let trace = r.frame().trace().expect("traced");
    let mut costs = trace.system_calls.iter().filter_map(|c| match &c.body {
        SyscallTraceBody::kInvoke { invoke } if &invoke.inputs.address == address => {
            Some(c.gas_remaining_at_start - c.gas_remaining_at_end)
        }
        _ => None,
    });
    let cost = costs.next().expect("an invoke of the handler");
    assert!(costs.next().is_none(), "expected exactly one invoke");
    cost
}

// Hand one request straight to the handler, as the driver does, and report
// what that frame spent.
fn measure(etx: &Etx, request: SwapRequest) -> u64 {
    let ctx = etx.ctx;
    let r = etx.env.transact(|tx| {
        tx.call(&TEST_ADDR).run(move || {
            SwapHandlerClient::new(&ctx.request_handler_addr)
                .with_gas_limit(REQUEST_GAS_MAX)
                .handle_request(request)
        })
    });
    r.assert_success();
    etx.advance_block();

    handler_cost(&r, &ctx.request_handler_addr)
}

const SWAP_IN_AMT: Amount = 2 * UNIT_AMT;

fn pledge(etx: &Etx, user: User, amounts: Amounts) {
    let ctx = etx.ctx;
    etx.exec_user_tx(user, |_| {
        ctx.token0()
            .adjust_allowance(&ctx.request_handler_addr, amounts[0] as i128);
        ctx.token1()
            .adjust_allowance(&ctx.request_handler_addr, amounts[1] as i128);
    })
    .expect("pledge");
    etx.advance_block();
}

fn measure_swap_exact_in(etx: &Etx) -> u64 {
    pledge(etx, ALICE, [SWAP_IN_AMT, 0]);
    measure(
        etx,
        SwapRequest::swap_exact_in(ALICE.addr, SWAP_IN_AMT, 0, 0, ALICE.addr),
    )
}

fn measure_swap_exact_out(etx: &Etx) -> u64 {
    pledge(etx, BOB, [SWAP_IN_AMT * 2, 0]);
    measure(
        etx,
        SwapRequest::swap_exact_out(BOB.addr, UNIT_AMT, SWAP_IN_AMT * 2, 0, BOB.addr),
    )
}

fn measure_add_liquidity(etx: &Etx) -> u64 {
    let amounts = [SWAP_IN_AMT, SWAP_IN_AMT];
    pledge(etx, CAROL, amounts);
    measure(
        etx,
        SwapRequest::add_liquidity(CAROL.addr, amounts, [0, 0], CAROL.addr),
    )
}

fn measure_remove_liquidity(etx: &Etx) -> u64 {
    let ctx = etx.ctx;

    // Carol has LP from the add above; let the handler take it back.
    let held = etx
        .exec_user_tx(CAROL, |_| {
            let held = ctx.lp().get_balance();
            ctx.lp()
                .adjust_allowance(&ctx.request_handler_addr, held as i128);
            held
        })
        .expect("lp allowance");
    etx.advance_block();

    measure(
        etx,
        SwapRequest::remove_liquidity(CAROL.addr, held, [0, 0], CAROL.addr),
    )
}
