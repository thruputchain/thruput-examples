//! [`batch_driver::Queue`]: the queue, its ceiling, its ids and its crank
//! floor.
//!
//! The individual pieces have their own tests -- `admission` for the ceiling, `drain_budget` for
//! the loop's gas budgeting, `queue_semantics` for the runtime rules underneath both. What is
//! tested here is what `Queue` adds by owning all of them: that an enqueue takes a slot and a drain
//! gives it back, that every accepted entry gets an id of its own, that a failed request is still
//! taken and still counted, and that a policy no crank could satisfy is refused at initialization.
//!
//! The other half of the policy -- refusing a crank that cannot fund what the queue owes -- is not
//! reachable from here. Starving a crank needs a frame with a real gas limit, and these
//! transactions run with `u64::MAX`, so no budget can exceed what the frame holds. `swap-driver`'s
//! `min_batch` tests cover it, calling `process_requests` through a client with a declared limit.

use batch_driver::{BatchRequest, CrankPolicy, Queue};
use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([4u8; 32]);

const CAPACITY: u32 = 2;
const MIN_BATCH: u32 = 2;

/// An ordinary request, cheap enough that a default frame drains any batch.
#[derive(ReadXDR, WriteXDR, Clone, Copy, Debug, PartialEq, Eq)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
struct Request {
    id: SHA256Hash,
}

impl BatchRequest for Request {
    const GAS_LIMIT: u64 = 100_000;

    fn gas_limit(&self) -> u64 {
        Self::GAS_LIMIT
    }

    fn id(&self) -> SHA256Hash {
        self.id
    }
}

/////////////////////// queue behavior //////////////////////////

// An enqueue takes a slot and a drain gives it back, so the ceiling keeps bounding the queue across
// batches without the driver arranging anything.
#[test]
fn draining_frees_the_room_an_enqueue_took() {
    let env = TestEnvironment::no_cost();
    initialize(&env, MIN_BATCH).assert_success();
    env.advance_block();

    enqueue(&env).assert_success();
    enqueue(&env).assert_success();

    // Full: the next one is early rather than wrong, so it fails at commit, left out of the block
    // to be submitted again once there is room.
    let overrun = enqueue(&env);
    overrun.frame().assert_success();
    overrun.assert_commit_failed_nondeterministically();
    env.advance_block();

    assert_eq!(crank(&env), (2, 0));
    env.advance_block();

    enqueue(&env).assert_success();
    enqueue(&env).assert_success();
}

// Every accepted entry gets an id of its own, including entries accepted in one transaction --
// which share a source-transaction hash.
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

/////////////////////// failure accounting /////////////////////////////////

// A request whose handling fails is still consumed, and still counts toward the batch: the drain
// reports it rather than stopping. A batch that stopped at its first failure would leave the rest
// of the queue hostage to one bad request.
#[test]
fn a_failed_request_does_not_stop_the_batch() {
    let env = TestEnvironment::no_cost();
    initialize(&env, MIN_BATCH).assert_success();
    env.advance_block();

    for _ in 0..CAPACITY {
        enqueue(&env).assert_success();
    }
    env.advance_block();

    let drained = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            // The *first* request fails, so a drain that stopped at a failure would report one
            // taken rather than two.
            let mut seen = 0;
            queue::<Request>()
                .crank(
                    || Ok(()),
                    |_request: Request, _gas| {
                        seen += 1;
                        if seen == 1 {
                            Err(CallError::Invalid)
                        } else {
                            Ok(())
                        }
                    },
                )
                .expect("affordable")
        })
    });
    drained.assert_success();
    assert_eq!(drained.assert_return_as::<(u32, u32)>(), (CAPACITY, 1));

    // Both left the queue, the failed one included, so both slots came back.
    env.advance_block();
    assert_eq!(crank(&env), (0, 0));
}

/////////////////////// the claim ///////////////////////////////////////////

// A crank claims the drain only when there is something to drain: one finding the queue empty
// stays free, and takes the claim from no crank that has work.
#[test]
fn a_crank_claims_only_when_there_is_work() {
    let env = TestEnvironment::no_cost();
    initialize(&env, MIN_BATCH).assert_success();
    env.advance_block();

    assert_eq!(crank_counting_claims(&env, Ok(())), ((0, 0), 0));

    enqueue(&env).assert_success();
    env.advance_block();
    assert_eq!(crank_counting_claims(&env, Ok(())), ((1, 0), 1));
}

// A crank whose claim fails -- another crank in the block holds it -- hands nothing to the handler
// and takes nothing from the queue, which a later crank then drains whole.
#[test]
fn a_crank_that_cannot_claim_drains_nothing() {
    let env = TestEnvironment::no_cost();
    initialize(&env, MIN_BATCH).assert_success();
    env.advance_block();

    enqueue(&env).assert_success();
    enqueue(&env).assert_success();
    env.advance_block();

    let refused = Err(CallError::Invalid);
    assert_eq!(crank_counting_claims(&env, refused), ((0, 0), 1));

    env.advance_block();
    assert_eq!(crank(&env), (2, 0));
}

/////////////////////// the policy //////////////////////////////////////////

// A floor above the ceiling asks for a batch the queue is never allowed to hold, which no crank
// could satisfy, so it is refused outright.
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

    // Nothing was set, so the queue admits nothing rather than admitting everything.
    enqueue(&env).assert_commit_failed_nondeterministically();
}

// A floor exactly at the ceiling is satisfiable -- a full queue is a batch a crank can be asked for
// -- so it is allowed.
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
                .crank(|| Ok(()), |_request: Request, _gas| Ok::<(), CallError>(()))
                .expect("affordable")
        })
    });
    drained.assert_success();
    drained.assert_return_as::<(u32, u32)>()
}

// Drain with a claim that returns `claim_result`, reporting the counts and how many times the crank
// claimed. A request reaching the handler would panic, so a refused claim must stop the drain.
fn crank_counting_claims(
    env: &TestEnvironmentHandle,
    claim_result: Result<(), CallError>,
) -> ((u32, u32), u32) {
    let refused = claim_result.is_err();
    let drained = env.transact(|tx| {
        tx.call(&ADDR).run(move || {
            let mut claims = 0u32;
            let counts = queue::<Request>()
                .crank(
                    || {
                        claims += 1;
                        if refused {
                            Err(CallError::Invalid)
                        } else {
                            Ok(())
                        }
                    },
                    |_request: Request, _gas| {
                        assert!(!refused, "a crank that could not claim drained a request");
                        Ok::<(), CallError>(())
                    },
                )
                .expect("affordable");
            (counts, claims)
        })
    });
    drained.assert_success();
    drained.assert_return_as::<((u32, u32), u32)>()
}
