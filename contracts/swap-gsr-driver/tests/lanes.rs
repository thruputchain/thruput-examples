//! [`LanedQueue`]: the driver's queue in lanes, drained by a crank that picks between their heads.
//!
//! The floor, the claim and the events are `batch_driver::Queue`'s own, and are tested with it.
//! What is tested here is what lanes add: the requests of one block are a batch, and batches leave
//! in the order of their blocks; within a batch, requests leave each lane in queue order, from
//! whichever lane the picker chooses, which hears how each fared; the lanes share one ceiling and
//! one source of ids; and a crank with nothing in any lane claims nothing.

use batch_driver::{BatchRequest, CLAIM_GAS, CrankPolicy, EPILOGUE_GAS};
use swap_gsr_driver::lanes::{LanePicker, LanedQueue, gas_for_laned_batch};
use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([6u8; 32]);

const LANES: usize = 2;
const CAPACITY: u32 = 4;

#[derive(ReadXDR, WriteXDR, Clone, Copy, Debug, PartialEq, Eq)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
struct Request {
    n: u32,
}

impl BatchRequest for Request {
    const GAS_LIMIT: u64 = 100_000;

    fn gas_limit(&self) -> u64 {
        Self::GAS_LIMIT
    }

    fn id(&self) -> SHA256Hash {
        self.n.hash()
    }
}

/// Alternates between the lanes while both hold requests, and records what it heard.
#[derive(Default)]
struct Alternate {
    last: usize,
    outcomes: Vec<bool>,
    batches: u32,
}

impl LanePicker<LANES> for Alternate {
    const GAS_PER_REQUEST: u64 = 50_000;

    fn begin_batch(&mut self) {
        self.batches += 1;
    }

    fn next(&mut self, waiting: &[bool; LANES]) -> usize {
        let other = 1 - self.last;
        self.last = if waiting[other] { other } else { self.last };
        self.last
    }

    fn handled(&mut self, ok: bool) {
        self.outcomes.push(ok);
    }
}

/// Always picks lane 0, whether or not it holds anything.
struct Blind;

impl LanePicker<LANES> for Blind {
    const GAS_PER_REQUEST: u64 = 0;

    fn next(&mut self, _waiting: &[bool; LANES]) -> usize {
        0
    }

    fn handled(&mut self, _ok: bool) {}
}

/// Takes lane 1 whenever it may.
struct Prefer1;

impl LanePicker<LANES> for Prefer1 {
    const GAS_PER_REQUEST: u64 = 0;

    fn next(&mut self, waiting: &[bool; LANES]) -> usize {
        usize::from(waiting[1])
    }

    fn handled(&mut self, _ok: bool) {}
}

// Requests leave each lane in queue order, from the lane the picker chooses among those of the
// oldest block waiting; it hears how each fared.
#[test]
fn the_picker_chooses_the_lane_and_each_lane_keeps_its_order() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    // Lane 0 holds 10, 11; lane 1 holds 20, 21. Each block puts a request in each lane.
    enqueue_block(&env, &[(0, 10), (1, 20)]);
    enqueue_block(&env, &[(0, 11), (1, 21)]);

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut picker = Alternate::default();
            let mut handled = Vec::new();
            let counts = queue()
                .crank(
                    || Ok(()),
                    Recording(&mut picker),
                    |request: Request, _gas| {
                        handled.push(request.n);
                        if request.n == 21 {
                            Err(CallError::Invalid)
                        } else {
                            Ok(())
                        }
                    },
                )
                .unwrap();
            (counts, handled, picker.outcomes)
        })
    });
    r.assert_success();

    let (counts, handled, outcomes) = r.assert_return_as::<((u32, u32), Vec<u32>, Vec<bool>)>();
    assert_eq!(counts, (4, 1));
    // `Alternate` starts by switching away from lane 0.
    assert_eq!(handled, [20, 10, 21, 11]);
    assert_eq!(outcomes, [true, true, false, true]);
}

// The picker orders a batch, not the queue: however much it prefers a lane, a request there waits
// for every request of an earlier block. So requests that keep arriving cannot keep overtaking one
// that came before them.
#[test]
fn a_later_block_does_not_overtake_an_earlier_one() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    enqueue(&env, 0, 1);
    enqueue_block(&env, &[(1, 20), (0, 2)]);
    enqueue(&env, 1, 30);

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut handled = Vec::new();
            queue()
                .crank(
                    || Ok(()),
                    Prefer1,
                    |request: Request, _gas| {
                        handled.push(request.n);
                        Ok(())
                    },
                )
                .unwrap();
            handled
        })
    });
    r.assert_success();

    // `Prefer1` gets its way within the second block, and nowhere else.
    assert_eq!(r.assert_return_as::<Vec<u32>>(), [1, 20, 2, 30]);
}

// The picker is told when the crank comes to each batch.
#[test]
fn the_picker_hears_each_batch_begin() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    enqueue_block(&env, &[(0, 10), (1, 20)]);
    enqueue_block(&env, &[(1, 21), (0, 11)]);

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut picker = Alternate::default();
            queue()
                .crank(|| Ok(()), Recording(&mut picker), |_: Request, _| Ok(()))
                .unwrap();
            picker.batches
        })
    });
    r.assert_success();
    assert_eq!(r.assert_return_as::<u32>(), 2);
}

// The lanes share one ceiling: a full queue turns a request away whatever its lane.
#[test]
fn the_lanes_share_one_ceiling() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    for n in 0..CAPACITY {
        enqueue(&env, 0, n);
    }

    let overrun = try_enqueue(&env, 1, 99);
    overrun.frame().assert_success();
    overrun.assert_commit_failed_nondeterministically();
}

// ... and one source of ids: two requests enqueued in one transaction, into different lanes, are
// told apart.
#[test]
fn ids_are_distinct_across_lanes() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut q = queue();
            let a = q.enqueue(0, |_| Request { n: 1 });
            let b = q.enqueue(1, |_| Request { n: 2 });
            a != b
        })
    });
    r.assert_success();
    assert!(r.assert_return_as::<bool>());
}

// A crank that finds every lane empty claims nothing and writes nothing.
#[test]
fn a_crank_with_nothing_waiting_claims_nothing() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue()
                .crank(
                    || panic!("nothing to claim for"),
                    Alternate::default(),
                    |_: Request, _| Ok(()),
                )
                .unwrap()
        })
    });
    r.assert_success();
    assert_eq!(r.assert_return_as::<(u32, u32)>(), (0, 0));
    assert_eq!(r.frame().trace().expect("traced").storage_writes.len(), 0);
}

// A picker that chooses an empty lane aborts the crank, which puts back whatever it had taken.
#[test]
fn a_picker_that_chooses_an_empty_lane_puts_the_batch_back() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    enqueue(&env, 0, 1);
    enqueue(&env, 1, 2);

    // `Blind` takes lane 0's one request, then picks lane 0 again.
    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue()
                .crank(|| Ok(()), Blind, |_: Request, _| Ok(()))
                .unwrap()
        })
    });
    assert!(!r.is_success());
    env.advance_block();

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue()
                .crank(|| Ok(()), Alternate::default(), |_: Request, _| Ok(()))
                .unwrap()
        })
    });
    r.assert_success();
    assert_eq!(r.assert_return_as::<(u32, u32)>(), (2, 0));
}

// Sizing a laned crank, as for a plain one, with each request costing its handling plus the
// picker's share.
#[test]
fn gas_for_laned_batch_counts_the_pickers_share() {
    const BATCH: u32 = 4;
    let per_request = Request::GAS_LIMIT + Alternate::GAS_PER_REQUEST;

    assert_eq!(
        gas_for_laned_batch::<Request, Alternate, LANES>(BATCH),
        EPILOGUE_GAS + CLAIM_GAS + u64::from(BATCH + 1) * per_request
    );
}

/////////////////////// helpers /////////////////////////////////////////////

// A picker that is a `&mut` to another, so a test can read it back after the crank.
struct Recording<'a, P>(&'a mut P);

impl<P: LanePicker<LANES>> LanePicker<LANES> for Recording<'_, P> {
    const GAS_PER_REQUEST: u64 = P::GAS_PER_REQUEST;

    fn begin_batch(&mut self) {
        self.0.begin_batch()
    }

    fn next(&mut self, waiting: &[bool; LANES]) -> usize {
        self.0.next(waiting)
    }

    fn handled(&mut self, ok: bool) {
        self.0.handled(ok)
    }
}

fn queue() -> LanedQueue<Request, LANES> {
    Keypath::default().into()
}

fn initialize(env: &TestEnvironmentHandle) {
    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue()
                .initialize(CrankPolicy {
                    capacity: CAPACITY,
                    min_batch: 0,
                })
                .expect("a zero floor is satisfiable");
        })
    })
    .assert_success();
    env.advance_block();
}

fn try_enqueue(env: &TestEnvironmentHandle, lane: usize, n: u32) -> TransactResult {
    let r = env.transact(|tx| {
        tx.call(&ADDR).run(move || {
            queue().enqueue(lane, |_| Request { n });
        })
    });
    env.advance_block();
    r
}

// Enqueue `n` into `lane`, in a block of its own: a batch of one.
fn enqueue(env: &TestEnvironmentHandle, lane: usize, n: u32) {
    try_enqueue(env, lane, n).assert_success();
}

// Enqueue each `(lane, n)` in turn, all in one block: one batch.
fn enqueue_block(env: &TestEnvironmentHandle, requests: &[(usize, u32)]) {
    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            for &(lane, n) in requests {
                queue().enqueue(lane, |_| Request { n });
            }
        })
    })
    .assert_success();
    env.advance_block();
}
