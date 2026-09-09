//! [`batch_driver::Queue`]: the queue, its ceiling, its ids and its crank
//! floor, held together.
//!
//! The individual pieces have their own tests -- `admission` for the ceiling,
//! `drain_budget` for the loop's gas budgeting, `queue_semantics` for the
//! runtime rules underneath both.  What is tested here is what `Queue` adds by
//! owning all of them: that an enqueue takes a slot and a drain gives it back,
//! that every accepted entry gets an id of its own, and that a policy no crank
//! could satisfy is refused at initialization.
//!
//! The other half of the policy -- refusing a crank that cannot fund what the
//! queue owes -- is not reachable from here.  Starving a crank needs a frame
//! with a real gas limit, and these transactions run with `u64::MAX`, so no
//! budget can exceed what the frame holds.  `swap-driver`'s `min_batch` tests
//! cover it, calling `process_requests` through a client with a declared
//! limit.

use batch_driver::{BatchRequest, CrankPolicy, Queue};
use sdk::storage::*;
use sdk::*;

const ADDR: ContractAddress = ContractAddress::new([4u8; 32]);

const CAPACITY: u32 = 2;
const MIN_BATCH: u32 = 2;

/// An ordinary request, cheap enough that a default frame drains any batch.
#[derive(ReadXDR, WriteXDR, Clone, Copy, Debug, PartialEq, Eq)]
#[xdrs(crate = "::sdk::__xdrs")]
struct Request {
    id: SHA256Hash,
}

impl BatchRequest for Request {
    const GAS_LIMIT: u64 = 100_000;

    fn gas_limit(&self) -> u64 {
        Self::GAS_LIMIT
    }
}

/////////////////////// queue behavior //////////////////////////

// An enqueue takes a slot and a drain gives it back, so the ceiling keeps
// bounding the queue across batches without the driver arranging anything.
#[test]
fn draining_frees_the_room_an_enqueue_took() {
    let env = TestEnvironment::no_cost();
    initialize(&env, MIN_BATCH).assert_success();
    env.advance_block();

    enqueue(&env).assert_success();
    enqueue(&env).assert_success();

    // Full: the next one is early rather than wrong, so it returns to the
    // mempool for a later block.
    let overrun = enqueue(&env);
    overrun.frame().assert_success();
    overrun.assert_commit_failed_nondeterministically();
    env.advance_block();

    assert_eq!(crank(&env), (2, 0));
    env.advance_block();

    enqueue(&env).assert_success();
    enqueue(&env).assert_success();
}

// Every accepted entry gets an id of its own, including entries accepted in
// one transaction -- which share a source-transaction hash.
#[test]
fn entries_from_one_transaction_get_distinct_ids() {
    let env = TestEnvironment::no_cost();
    initialize(&env, MIN_BATCH).assert_success();
    env.advance_block();

    let ids = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut q = queue::<Request>();
            [
                q.enqueue(|id| Request { id }),
                q.enqueue(|id| Request { id }),
            ]
        })
    });
    ids.assert_success();

    let [a, b] = ids.assert_return_as::<[SHA256Hash; 2]>();
    assert_ne!(a, b);
}

/////////////////////// the policy //////////////////////////////////////////

// A floor above the ceiling asks for a batch the queue is never allowed to
// hold, which no crank could satisfy, so it is refused outright.
#[test]
fn a_floor_above_the_ceiling_is_refused() {
    let env = TestEnvironment::no_cost();

    let init = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue::<Request>()
                .initialize(CrankPolicy {
                    capacity: CAPACITY,
                    min_batch: CAPACITY + 1,
                })
                .is_ok()
        })
    });
    init.assert_success();
    assert!(!init.assert_return_as::<bool>());

    // Nothing was set, so the queue admits nothing rather than admitting
    // everything.
    enqueue(&env).assert_commit_failed_nondeterministically();
}

// A floor exactly at the ceiling is satisfiable -- a full queue is a batch a
// crank can be asked for -- so it is allowed.
#[test]
fn a_floor_at_the_ceiling_is_allowed() {
    let env = TestEnvironment::no_cost();

    initialize(&env, CAPACITY).assert_success();
    env.advance_block();

    enqueue(&env).assert_success();
}

/////////////////////// helpers /////////////////////////////////////////////

fn queue<R: BatchRequest>() -> Queue<R> {
    Keypath::default().into()
}

fn initialize(env: &TestEnvironmentHandle, min_batch: u32) -> TransactResult {
    env.transact(move |tx| {
        tx.call(&ADDR).run(move || {
            queue::<Request>()
                .initialize(CrankPolicy {
                    capacity: CAPACITY,
                    min_batch,
                })
                .expect("policy is satisfiable");
        })
    })
}

fn enqueue(env: &TestEnvironmentHandle) -> TransactResult {
    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue::<Request>().enqueue(|id| Request { id });
        })
    })
}

// Drain with a request type any frame can afford.
fn crank(env: &TestEnvironmentHandle) -> (u32, u32) {
    let drained = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue::<Request>()
                .crank(|_request: Request, _gas| Ok::<(), ()>(()))
                .expect("affordable")
        })
    });
    drained.assert_success();
    drained.assert_return_as::<(u32, u32)>()
}
