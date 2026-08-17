mod common;
use common::*;
use std::iter::zip;

const SWAP_IN_AMT: Amount = 2 * UNIT_AMT;

// A single swap leg: who swaps, which token index they pay in, and how much.
#[derive(Copy, Clone)]
struct Leg {
    user: User,
    in_index: usize,
    amount_in: Amount,
}

/////////////////////// SERIAL /////////////////////////////

#[test]
fn serial_swap_both() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        serial_swap(&etx)
    });
}

#[test]
fn serial_swap_one() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;

        let user = CAROL;
        etx.user_print_balances(user)?;

        serial_swap_leg(
            &etx,
            Leg {
                user,
                in_index: 0,
                amount_in: SWAP_IN_AMT,
            },
        )
    });
}

fn serial_swap(etx: &Etx) -> Result<()> {
    etx.user_print_balances(CAROL)?;
    etx.user_print_balances(DAVE)?;

    // Carol swaps token0 -> token1, then Dave swaps token1 -> token0.
    serial_swap_leg(
        etx,
        Leg {
            user: CAROL,
            in_index: 0,
            amount_in: SWAP_IN_AMT,
        },
    )?;
    serial_swap_leg(
        etx,
        Leg {
            user: DAVE,
            in_index: 1,
            amount_in: SWAP_IN_AMT,
        },
    )?;

    Ok(())
}

// Perform one swap directly against the pair, pricing it from the reserves live
// at this moment -- exactly as the handler does at execution time.  (So a serial
// run and a batched run, executed in the same order, agree.)
#[rustfmt::skip]
fn serial_swap_leg(etx: &Etx, leg: Leg) -> Result<()> {
    let ctx = &etx.ctx;
    let Leg { user, in_index, amount_in } = leg;

    let mut amounts_in: Amounts = [0, 0];
    amounts_in[in_index] = amount_in;

    // Price the swap against current reserves.
    let amounts_out = etx.calculate_swap(amounts_in)?;

    // Send the purchasing funds to the swap-pair contract
    etx.exec_user_tx(user, |_| {
        ctx.token0().transfer(&ctx.pair_addr, amounts_in[0]);
        ctx.token1().transfer(&ctx.pair_addr, amounts_in[1]);
    })?;

    /* ----- */ etx.advance_block(); /* ----- */

    // Perform the swap
    etx.exec_user_tx(user, |user| {
        ctx.pair().swap(amounts_out[0], amounts_out[1], user.addr, user.addr, None)
    })?;

    println!("> {} swapped {:.3?} => {:.3?}", user.name,
        amounts_decimalized(amounts_in),
        amounts_decimalized(amounts_out),
    );

    /* ----- */ etx.advance_block(); /* ----- */

    etx.user_print_balances(user)?;

    Ok(())
}

/////////////////////// CONCURRENT /////////////////////////////

#[test]
fn concurrent_swap_one() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        let strategy = [(
            Leg {
                user: CAROL,
                in_index: 0,
                amount_in: SWAP_IN_AMT,
            },
            true,
        )];
        concurrent_swap_strategy(&etx, strategy, 0)
    });
}

#[test]
fn concurrent_swap_only() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;
        concurrent_swap(&etx)
    });
}

fn concurrent_swap(etx: &Etx) -> Result<()> {
    // The two users involved, their input token, and their swap-in amounts.
    let strategy = [
        (
            Leg {
                user: CAROL,
                in_index: 0,
                amount_in: SWAP_IN_AMT,
            },
            true,
        ),
        (
            Leg {
                user: DAVE,
                in_index: 1,
                amount_in: SWAP_IN_AMT,
            },
            true,
        ),
    ];
    concurrent_swap_strategy(etx, strategy, 0)
}

// Can we continue handling swap requests after one fails?  Here Dave grants no
// allowance, so the handler can't pull his funds and his request fails -- while
// Carol's still goes through.
#[test]
fn concurrent_swap_transfer_failure() {
    transact_assert_success(|| {
        let etx = setup_etx_primed()?;

        let strategy = [
            (
                Leg {
                    user: CAROL,
                    in_index: 0,
                    amount_in: SWAP_IN_AMT,
                },
                true,
            ),
            (
                Leg {
                    user: DAVE,
                    in_index: 1,
                    amount_in: SWAP_IN_AMT,
                },
                false,
            ),
        ];

        concurrent_swap_strategy(&etx, strategy, 1)
    });
}

#[rustfmt::skip]
fn concurrent_swap_strategy<const N: usize>(
    etx: &Etx,
    strategy: [(Leg, bool); N],
    n_failures_expected: u32,
) -> Result<()> {
    let ctx = &etx.ctx;

    let start_balances = strategy.map(|(leg, _)| {
        etx.user_balances(leg.user).unwrap()
    });

    for (leg, _) in strategy {
        etx.user_print_balances(leg.user)?
    }

    // Give the request handler access to the purchasing funds.  A leg we expect
    // to fail grants no allowance, so the handler can't pull its funds.
    for (leg, should_succeed) in strategy {
        let allowed = if should_succeed { leg.amount_in } else { 0 };
        let mut amounts: Amounts = [0, 0];
        amounts[leg.in_index] = allowed;

        println!("{} pledges {:.3?}", leg.user.name, amounts_decimalized(amounts));
        etx.exec_user_tx(leg.user, |_| {
            ctx.token0().adjust_allowance(
                &ctx.request_handler_addr,
                amounts[0].try_into().unwrap(),
            );
            ctx.token1().adjust_allowance(
                &ctx.request_handler_addr,
                amounts[1].try_into().unwrap(),
            );
        })?;
    }

    /* ----- */ etx.advance_block(); /* ----- */

    for (leg, _) in strategy {
        println!("{} has pledged {:.3?}", leg.user.name, etx.user_pledges(leg.user)?);
    }

    // All users submit swap requests (accepting any output: min is 0).  The
    // output amount is determined when each request is handled.
    for (leg, _) in strategy {
        etx.exec_user_tx(leg.user, |u| {
            ctx.driver().request(SwapRequest::swap_exact_in(
                u.addr,
                leg.amount_in,
                0,
                leg.in_index as u32,
                u.addr,
            ))
        })?;

        println!("> {} requested swap of {:.3} of token {}", leg.user.name,
            decimalized(leg.amount_in), leg.in_index);
    }

    /* (No block boundary needed here.) */

    // Process requests
    let (n_processed, n_failed) = etx.process_requests()?;

    assert_eq!(n_processed, N as u32);
    assert_eq!(n_failed, n_failures_expected);

    /* ----- */ etx.advance_block(); /* ----- */

    for (leg, _) in strategy {
        etx.user_print_balances(leg.user)?;
    }

    // Inspect resulting balances
    for ((leg, should_succeed), (start, start_lp)) in zip(strategy, start_balances) {
        let (end, end_lp) = etx.user_balances(leg.user)?;

        assert_eq!(start_lp, end_lp);

        if should_succeed {
            let out = 1 - leg.in_index;

            // We paid in with our input token...
            assert_eq!(end[leg.in_index], start[leg.in_index].strict_sub(leg.amount_in),
                "Something wrong with {}", leg.user.name);

            // ...and got some amount of the other token back.
            assert!(end[out] > start[out]);
        } else {
            // A failed request leaves our balances untouched.
            assert_eq!(start, end);
        }
    }

    Ok(())
}

/////////////////////// COMPARE /////////////////////////////

// Do a pair of swaps both serially and concurrently, comparing the results.
#[test]
fn compare_swap() {
    println!("\n[Serial]");
    let serial = transact_assert_success(|| {
        let etx = setup_etx_primed()?;

        serial_swap(&etx)?;

        etx.record_stats(CAROL, DAVE)
    });

    println!("\n[Concurrent]");
    let concurrent = transact_assert_success(|| {
        let etx = setup_etx_primed()?;

        concurrent_swap(&etx)?;

        etx.record_stats(CAROL, DAVE)
    });

    println!("swap serial: \n{}", serial);
    println!("swap concurrent: \n{}", concurrent);

    assert_eq!(serial, concurrent);
}
