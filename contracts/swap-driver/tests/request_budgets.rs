//! `REQUEST_GAS_MAX` has to bound what any one request asks for.
//!
//! [`batch_driver::process`] checks that the frame can afford `GAS_LIMIT` before it takes a request
//! -- before it can see which kind it is -- and then hands the request the budget it asks for. If
//! some operation could ask for more than `GAS_LIMIT`, the loop would take a request it could not
//! pay to handle, and the request would fail for want of gas.
//!
//! `REQUEST_GAS_MAX` is computed as the largest of the declared budgets, so the only way to break
//! this is to add an operation and leave its budget out of that list. The match in `gas_limit` is
//! exhaustive, so a new operation must be given a budget; this walks one request of every kind to
//! check that the budget it names is one the list knows about.

use batch_driver::BatchRequest;
use swap_if::*;

const SOMEBODY: Address = Address::new([1u8; 32]);
const SOME_AMOUNT: Amount = 1_000;

#[test]
fn request_gas_max_bounds_every_operation() {
    let every_kind = [
        SwapRequest::add_liquidity(&SOMEBODY, [SOME_AMOUNT, SOME_AMOUNT], [0, 0], &SOMEBODY),
        SwapRequest::remove_liquidity(&SOMEBODY, SOME_AMOUNT, [0, 0], &SOMEBODY),
        SwapRequest::swap_exact_in(&SOMEBODY, SOME_AMOUNT, 0, 0, &SOMEBODY),
        SwapRequest::swap_exact_out(&SOMEBODY, SOME_AMOUNT, SOME_AMOUNT, 0, &SOMEBODY),
    ];

    for request in every_kind {
        assert!(
            request.gas_limit() <= REQUEST_GAS_MAX,
            "an operation asks for {}, past the {REQUEST_GAS_MAX} the drain \
             loop budgets: its figure is missing from `REQUEST_GAS`",
            request.gas_limit(),
        );
    }
}

// And the bound is tight -- some operation actually costs the maximum, so the loop is not budgeting
// for a request that cannot exist.
#[test]
fn request_gas_max_is_reached_by_some_operation() {
    assert_eq!(
        SwapRequest::remove_liquidity(&SOMEBODY, SOME_AMOUNT, [0, 0], &SOMEBODY).gas_limit(),
        REQUEST_GAS_MAX,
    );
}
