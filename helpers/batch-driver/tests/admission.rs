//! [`batch_driver::Slots`]: the ceiling on how much a driver's queue can be
//! made to hold.
//!
//! The point of holding capacity as a countdown rather than a length is that
//! concurrent enqueues never read it, so they never conflict with each other --
//! only with the ceiling, and only in aggregate.  The point of taking a slot
//! *lazily* is what becomes of an enqueue that arrives at a full queue: it is
//! excluded from its block and returned to the mempool, rather than reverted
//! and lost.

use batch_driver::Slots;
use sdk::storage::*;
use sdk::*;

const ADDR: ContractAddress = ContractAddress::new([3u8; 32]);

const CAPACITY: u32 = 2;

// Enqueues within the ceiling all land, in the same block, without conflicting
// with each other.
#[test]
fn concurrent_enqueues_within_the_ceiling_all_land() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();
}

// The one that overruns the ceiling is excluded -- a non-deterministic commit
// failure, so it returns to the mempool for a later block rather than being
// spent here.
#[test]
fn an_enqueue_overrunning_the_ceiling_is_deferred() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();

    let overrun = reserve(&env);
    overrun.frame().assert_success(); // the contract ran fine: being early is not an error
    overrun.assert_commit_failed_nondeterministically();
}

// A full queue defers the next enqueue in the same way, from the very first
// transaction of the block: the ceiling is a property of the committed state,
// not of one block's traffic.
#[test]
fn a_full_queue_defers_the_next_enqueue() {
    let env = TestEnvironment::no_cost();
    set_capacity(&env);

    reserve(&env).assert_success();
    reserve(&env).assert_success();
    env.advance_block();

    reserve(&env).assert_commit_failed_nondeterministically();
}

// Draining returns the slots, and the deferred enqueue then fits.
#[test]
fn draining_makes_room_again() {
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

// Setting the ceiling is what establishes it: without it the slots start at
// zero, so a driver that skipped initialization accepts nothing (rather than
// silently accepting everything).
#[test]
fn an_unset_ceiling_admits_nothing() {
    let env = TestEnvironment::no_cost();

    reserve(&env).assert_commit_failed_nondeterministically();
}

/////////////////////// helpers /////////////////////////////////////////////

fn with_slots(
    env: &TestEnvironmentHandle,
    f: impl FnOnce(&mut Slots) + std::panic::UnwindSafe,
) -> TransactResult {
    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut slots: Node<Slots> = Keypath::default().into();
            f(&mut slots);
        })
    })
}

fn set_capacity(env: &TestEnvironmentHandle) {
    with_slots(env, |slots| slots.set_capacity(CAPACITY)).assert_success();
    env.advance_block();
}

fn reserve(env: &TestEnvironmentHandle) -> TransactResult {
    with_slots(env, |slots| slots.reserve())
}

fn release(env: &TestEnvironmentHandle, count: u32) -> TransactResult {
    with_slots(env, move |slots| slots.release(count))
}
