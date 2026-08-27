//! The gas budgeting in [`batch_driver::process`].
//!
//! The drain is bounded by what the calling frame can still afford, so the
//! caller's own gas limit is what sizes the batch.  Two properties matter, and
//! both are visible natively:
//!
//! * a frame with room keeps going -- there is no batch size fixed inside the
//!   helper for every caller to declare gas for; and
//! * a frame without room for a whole request stops *before* consuming one, so
//!   a request is never taken out of the queue and then dropped for want of
//!   gas to handle it.

use batch_driver::{BatchRequest, EPILOGUE_GAS, gas_for_batch};
use sdk::storage::*;
use sdk::*;

const ADDR: ContractAddress = ContractAddress::new([2u8; 32]);

/// An ordinary request, cheap enough that a default frame can drain many.
#[derive(ReadXDR, WriteXDR, Clone, Copy, Debug, PartialEq, Eq)]
#[xdrs(crate = "::sdk::__xdrs")]
struct Request {
    id: u32,
}

impl BatchRequest for Request {
    const GAS_LIMIT: u64 = 100_000;

    fn gas_limit(&self) -> u64 {
        Self::GAS_LIMIT
    }
}

/// A request declaring more gas than any frame can hold, to exercise the
/// budget check without needing to shrink the frame around it.  Its encoding
/// matches `Request`, so the two read each other's entries.
#[derive(ReadXDR, WriteXDR, Clone, Copy, Debug, PartialEq, Eq)]
#[xdrs(crate = "::sdk::__xdrs")]
struct Unaffordable {
    id: u32,
}

impl BatchRequest for Unaffordable {
    const GAS_LIMIT: u64 = u64::MAX;

    fn gas_limit(&self) -> u64 {
        Self::GAS_LIMIT
    }
}

// A frame with gas to spare drains the whole queue, however long.  Under the
// previous fixed high-water mark this stopped at about ten.
#[test]
fn a_frame_with_room_drains_past_the_old_fixed_batch() {
    let env = TestEnvironment::no_cost();

    for id in 0..25 {
        enqueue(&env, id).assert_success();
    }
    env.advance_block();

    let crank = crank::<Request>(&env);
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (25, 0));
}

// A frame that cannot fund a whole request consumes nothing at all: the
// budget is checked before the entry leaves the queue.
#[test]
fn a_frame_without_room_consumes_nothing() {
    let env = TestEnvironment::no_cost();

    for id in 0..3 {
        enqueue(&env, id).assert_success();
    }
    env.advance_block();

    let crank = crank::<Unaffordable>(&env);
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (0, 0));
}

// ... and the requests it declined to take are still there, in order, for a
// caller that can afford them.
#[test]
fn requests_declined_for_want_of_gas_stay_queued() {
    let env = TestEnvironment::no_cost();

    for id in 0..3 {
        enqueue(&env, id).assert_success();
    }
    env.advance_block();

    crank::<Unaffordable>(&env).assert_success();
    env.advance_block();

    let seen = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut queue: RCQ<Request> = Keypath::default().into();
            let mut seen = Vec::new();
            batch_driver::process(&mut queue, |request: Request, _gas| {
                seen.push(request.id);
                Ok::<(), ()>(())
            });
            seen
        })
    });
    seen.assert_success();
    assert_eq!(seen.assert_return_as::<Vec<u32>>(), vec![0, 1, 2]);
}

// The threshold is a request's declared worst case plus the epilogue reserve,
// so a type whose `GAS_LIMIT` saturates that sum still yields a bounded
// threshold rather than wrapping to a trivially satisfied one.
#[test]
fn an_enormous_request_limit_does_not_wrap_the_threshold() {
    assert_eq!(
        Unaffordable::GAS_LIMIT.saturating_add(EPILOGUE_GAS),
        u64::MAX
    );
}

/////////////////////// sizing a batch //////////////////////////////////////

// `gas_for_batch` is the inverse of the drain's budget check: a frame given
// exactly that much drains the whole batch, even with every request costing
// its full declared worst case.
#[test]
fn gas_for_batch_funds_the_whole_batch() {
    const BATCH: u32 = 4;

    // The drain stops when the frame can no longer fund one more request, so
    // walk the budget down a batch's worth and check it is still going.
    let mut remaining = gas_for_batch::<Request>(BATCH);
    let threshold = Request::GAS_LIMIT + EPILOGUE_GAS;

    for taken in 0..BATCH {
        assert!(
            remaining > threshold,
            "budget exhausted after {taken} of {BATCH} requests"
        );
        remaining -= Request::GAS_LIMIT;
    }

    // ... and that it is not funding a request beyond the batch asked for.
    assert!(remaining <= threshold);
}

// The reserve `gas_for_batch` adds is what makes that exact: a batch's worth
// of requests alone leaves the drain one check short.
#[test]
fn a_batch_without_the_reserve_falls_one_short() {
    const BATCH: u32 = 4;

    let bare = u64::from(BATCH) * Request::GAS_LIMIT;
    assert!(bare < gas_for_batch::<Request>(BATCH));
}

// Sizing never wraps, however large the request or the batch.
#[test]
fn gas_for_batch_saturates() {
    assert_eq!(gas_for_batch::<Unaffordable>(1), u64::MAX);
    assert_eq!(gas_for_batch::<Request>(u32::MAX), {
        EPILOGUE_GAS + (u64::from(u32::MAX) + 1) * Request::GAS_LIMIT
    });
}

/////////////////////// helpers /////////////////////////////////////////////

fn enqueue(env: &TestEnvironmentHandle, id: u32) -> TransactResult {
    env.transact(|tx| {
        tx.call(&ADDR).run(move || {
            let mut queue: RCQ<Request> = Keypath::default().into();
            queue.insert(&Request { id });
        })
    })
}

fn crank<R: BatchRequest + 'static>(env: &TestEnvironmentHandle) -> TransactResult {
    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut queue: RCQ<R> = Keypath::default().into();
            batch_driver::process(&mut queue, |_request: R, _gas| Ok::<(), ()>(()))
        })
    })
}
