//! The admission semantics a [`batch_driver::Queue`] rests on.
//!
//! A queue's ceiling is a [`CapacityConstraint`]: the room still left, taken as entries arrive and
//! given back as they leave. These rules are the SDK type's and the runtime's rather than this
//! crate's, but `Queue` is only correct because of them -- and the one that matters most is not a
//! property of the count but of how a transaction that overruns it is treated.
//!
//! The point of holding capacity as a countdown rather than a length is that concurrent additions
//! never read it, so they never conflict with each other -- only with the ceiling, and only in
//! aggregate. The point of taking a slot *lazily* is what becomes of an addition that arrives at a
//! full collection: it is excluded from its block and returned to the mempool, rather than reverted
//! and lost.

use sdk::storage::*;
use sdk::*;

const ADDR: ContractAddress = ContractAddress::new([3u8; 32]);

const CAPACITY: i128 = 2;

// Additions within the ceiling all land, in the same block, without conflicting with each other.
#[test]
fn concurrent_adds_within_the_ceiling_all_land() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();
}

// The one that overruns the ceiling is excluded -- a non-deterministic commit failure, so it
// returns to the mempool for a later block rather than being spent here.
#[test]
fn an_add_overrunning_the_ceiling_is_deferred() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();

    let overrun = reserve(&env);
    overrun.frame().assert_success(); // the contract ran fine: being early is not an error
    overrun.assert_commit_failed_nondeterministically();
}

// A full collection defers the next add in the same way, from the very first transaction of the
// block: the ceiling is a property of the committed state, not of one block's traffic.
#[test]
fn a_full_collection_defers_the_next_add() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();
    env.advance_block();

    reserve(&env).assert_commit_failed_nondeterministically();
}

// Releasing returns the slots, and the deferred add then fits.
#[test]
fn releasing_makes_room_again() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();
    env.advance_block();

    release(&env, 2).assert_success();
    env.advance_block();

    reserve(&env).assert_success();
    reserve(&env).assert_success();
}

// Setting the ceiling is what establishes it: without it the slots start at zero, so a driver that
// skipped initialization accepts nothing (rather than silently accepting everything).
#[test]
fn an_unset_ceiling_admits_nothing() {
    let env = TestEnvironment::no_cost();

    reserve(&env).assert_commit_failed_nondeterministically();
}

// Setting the ceiling discards whatever the transaction recorded, so doing it after taking a slot
// is refused rather than allowed to lose the slot.
#[test]
fn resetting_the_ceiling_after_taking_a_slot_is_refused() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    let reset = with_slots(&env, |slots| {
        slots.consume_capacity(1);
        slots.set_capacity(CAPACITY);
    });
    reset.frame().assert_abort();
}

// That check is within a transaction only. A ceiling set again in a later transaction forgets the
// slots still outstanding -- which is why a contract that must be initialized once needs its own
// guard, and why this is pinned here rather than left as a surprise.
#[test]
fn resetting_the_ceiling_in_a_later_transaction_forgets_outstanding_slots() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();
    env.advance_block();

    with_slots(&env, |slots| slots.set_capacity(CAPACITY)).assert_success();
    env.advance_block();

    // The collection is full, but the reset forgot both slots, so it admits another CAPACITY
    // entries.
    for _ in 0..CAPACITY {
        reserve(&env).assert_success();
    }
}

/////////////////////// helpers /////////////////////////////////////////////

fn with_slots(
    env: &TestEnvironmentHandle,
    f: impl FnOnce(&mut CapacityConstraint) + std::panic::UnwindSafe,
) -> TransactResult {
    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut slots: Node<CapacityConstraint> = Keypath::default().into();
            f(&mut slots);
        })
    })
}

fn set_capacity(env: &TestEnvironmentHandle) {
    with_slots(env, |slots| slots.set_capacity(CAPACITY)).assert_success();
    env.advance_block();
}

fn reserve(env: &TestEnvironmentHandle) -> TransactResult {
    with_slots(env, |slots| slots.consume_capacity(1))
}

fn release(env: &TestEnvironmentHandle, count: u32) -> TransactResult {
    with_slots(env, move |slots| slots.consume_capacity(-i128::from(count)))
}
