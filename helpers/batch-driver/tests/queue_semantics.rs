//! The queue semantics [`batch_driver::Queue`]'s drain rests on.
//!
//! `process` drains an `RCQ` that concurrent transactions are inserting into, and a driver's
//! cranking policy is built on top of what the runtime does when several transactions in one block
//! touch that queue. Those rules are not local to this crate -- they are the retro-causal queue's
//! -- but the drain loop is only correct because of them, and a policy built on the wrong model of
//! them fails in ways that are hard to see from a single transaction.
//!
//! The load-bearing rule: a crank either does work or is deferred to a later block. It never
//! observes a queue that another transaction drained out from under it in the same block, and it
//! only no-ops when the queue was genuinely empty at the block snapshot.

use sdk::storage::*;
use sdk::*;

const ADDR: ContractAddress = ContractAddress::new([1u8; 32]);

// The queue's entries. These tests never drain through the helper, so this needs no `BatchRequest`
// impl -- only the encoding that lets it sit in an `RCQ`.
#[derive(ReadXDR, WriteXDR, Clone, Copy, Debug, PartialEq, Eq)]
#[xdrs(crate = "::sdk::__xdrs")]
struct Request {
    id: u32,
}

/////////////////////// A crank does work, or is deferred ///////////////////

// Baseline: a crank drains what was queued in an earlier block.
#[test]
fn crank_drains_the_queue() {
    let env = TestEnvironment::no_cost();

    enqueue(&env, 1).assert_success();
    enqueue(&env, 2).assert_success();
    env.advance_block();

    let crank = crank(&env);
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (2, 0));

    // ... and leaves it empty.
    env.advance_block();
    assert_eq!(crank_returning(&env), (0, 0));
}

// Only one transaction per block may consume from a queue. The loser's root frame returns
// successfully, but its delta batch fails reservation with a *non-deterministic* error -- so it is
// excluded from the block and returned to the mempool, to be re-evaluated in a later one. Cranks
// racing for a block therefore queue up across blocks by themselves; no client-side arbitration is
// needed.
#[test]
fn only_one_crank_per_block_commits() {
    let env = TestEnvironment::no_cost();

    enqueue(&env, 1).assert_success();
    enqueue(&env, 2).assert_success();
    env.advance_block();

    crank(&env).assert_success();
    crank(&env).assert_commit_failed_nondeterministically();
}

// The loser above does *not* see an empty queue: it reads the same snapshot as the winner and
// consumes the same entries. There is no "the queue drained out from under me" outcome to code
// against.
#[test]
fn a_losing_crank_sees_the_undrained_snapshot() {
    let env = TestEnvironment::no_cost();

    enqueue(&env, 1).assert_success();
    enqueue(&env, 2).assert_success();
    env.advance_block();

    crank(&env).assert_success();

    let loser = crank(&env);
    assert_eq!(
        loser.assert_return_as::<(u32, u32)>(),
        (2, 0),
        "the loser executed against the same snapshot as the winner"
    );
    loser.assert_commit_failed_nondeterministically();
}

/////////////////////// A no-op crank is free ///////////////////////////////

// A crank against a queue that was empty at the block snapshot returns (0, 0) and writes *no
// storage delta at all*. It has nothing to reserve, so it cannot conflict with anything, and it
// commits: a degenerate crank is terminal, not retried.
#[test]
fn crank_on_an_empty_queue_is_a_free_no_op() {
    let env = TestEnvironment::no_cost();

    let crank = crank(&env);
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (0, 0));
    assert_eq!(storage_writes(&crank), 0, "a no-op crank writes no delta");
}

// Which is why any number of them can share a block.
#[test]
fn no_op_cranks_do_not_conflict_with_each_other() {
    let env = TestEnvironment::no_cost();

    crank(&env).assert_success();
    crank(&env).assert_success();
    crank(&env).assert_success();
}

// ... and why one does not spoil a request submitted later in the same block. The request is simply
// served by a later crank.
#[test]
fn a_no_op_crank_does_not_conflict_with_a_concurrent_enqueue() {
    let env = TestEnvironment::no_cost();

    let crank = crank(&env);
    let request = enqueue(&env, 1);

    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (0, 0));
    request.assert_success();

    env.advance_block();
    assert_eq!(crank_returning(&env), (1, 0));
}

/////////////////////// Same-block service is a bonus ///////////////////////

// A crank the proposer orders *after* an enqueue picks that request up in the same block -- this is
// what the queue's retro-causality buys.
#[test]
fn a_crank_ordered_after_an_enqueue_serves_it_in_the_same_block() {
    let env = TestEnvironment::no_cost();

    enqueue(&env, 1).assert_success();

    let crank = crank(&env);
    crank.assert_success();
    assert_eq!(crank.assert_return_as::<(u32, u32)>(), (1, 0));
}

// Ordered before it, the same crank sees nothing. Since ordering is the proposer's choice,
// same-block service cannot be relied on -- but the downside is only the free no-op above, and the
// request keeps its place.
#[test]
fn a_crank_ordered_before_an_enqueue_leaves_it_queued() {
    let env = TestEnvironment::no_cost();

    assert_eq!(crank_returning(&env), (0, 0));
    enqueue(&env, 1).assert_success();

    env.advance_block();
    assert_eq!(crank_returning(&env), (1, 0));
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

// Drain the queue dry, and report how much was taken.
//
// Deliberately a local loop rather than `Queue::crank`: what these tests pin is the runtime's
// behaviour when several transactions in one block touch a queue, and routing through the helper
// would put its slot accounting and its events into the deltas being compared. The loop is
// unbounded because gas is free here -- the helper's real budgeting is `drain_budget`'s subject.
fn crank(env: &TestEnvironmentHandle) -> TransactResult {
    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut queue: RCQ<Request> = Keypath::default().into();
            let mut processed = 0u32;
            while queue.try_consume().none_if_missing().is_some() {
                processed += 1;
            }
            (processed, 0u32)
        })
    })
}

// A crank expected to commit, reduced to its (processed, failed) counts.
fn crank_returning(env: &TestEnvironmentHandle) -> (u32, u32) {
    let result = crank(env);
    result.assert_success();
    result.assert_return_as::<(u32, u32)>()
}

fn storage_writes(result: &TransactResult) -> usize {
    result
        .frame()
        .trace()
        .expect("the mock environment traces every frame")
        .storage_writes
        .len()
}
