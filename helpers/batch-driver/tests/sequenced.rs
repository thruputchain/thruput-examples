//! [`batch_driver::Queue::crank_sequenced`]: a crank that lets a [`Sequencer`] order its batch.
//!
//! The floor, the claim and the events are `crank`'s own and are tested with it. What is tested
//! here is what sequencing adds: the batch is the queue's earliest entries, taken whole and shown to
//! the sequencer before any is handled; each is then handled once, in the order the sequencer
//! chooses, and told how it fared; and a crank takes no more of the queue than it can afford to
//! handle, the sequencer's share included.
//!
//! As in `queue.rs`, these frames run with `u64::MAX` gas; how far a declared limit goes is tested
//! with a real one, in `swap-clvr-driver`.

use batch_driver::{
    BatchRequest, CLAIM_GAS, CrankPolicy, EPILOGUE_GAS, Queue, Sequencer, gas_for_sequenced_batch,
};
use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([5u8; 32]);

const CAPACITY: u32 = 32;

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

/// Hands the batch out last first, and records what it was shown and told.
struct Reverse {
    shown: Vec<u32>,
    left: usize,
    outcomes: Vec<bool>,
}

impl Reverse {
    fn new(batch: &[Request]) -> Self {
        Reverse {
            shown: batch.iter().map(|r| r.n).collect(),
            left: batch.len(),
            outcomes: Vec::new(),
        }
    }
}

impl Sequencer for Reverse {
    const GAS_PER_REQUEST: u64 = 50_000;

    fn next(&mut self) -> usize {
        self.left -= 1;
        self.left
    }

    fn handled(&mut self, ok: bool) {
        self.outcomes.push(ok);
    }
}

/// Costs more than any frame holds.
struct Dear;

impl Sequencer for Dear {
    const GAS_PER_REQUEST: u64 = u64::MAX;

    fn next(&mut self) -> usize {
        unreachable!("never given a batch to order")
    }

    fn handled(&mut self, _ok: bool) {}
}

/// Picks the first request every time.
struct Stuck;

impl Sequencer for Stuck {
    const GAS_PER_REQUEST: u64 = 0;

    fn next(&mut self) -> usize {
        0
    }

    fn handled(&mut self, _ok: bool) {}
}

// The sequencer sees the whole batch, in queue order, before anything is handled; each request is
// then handled once in the order it chooses, and it hears how each fared.
#[test]
fn the_batch_is_handled_in_the_sequencers_order() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    for n in 0..5 {
        enqueue(&env, n);
    }
    env.advance_block();

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut sequencer = None;
            let mut handled = Vec::new();
            let counts = queue()
                .crank_sequenced(
                    || Ok(()),
                    |batch| {
                        // Nothing has been handled yet.
                        sequencer = Some(Reverse::new(batch));
                        Recording(sequencer.as_mut().unwrap())
                    },
                    |request: Request, _gas| {
                        handled.push(request.n);
                        // Odd ones fail.
                        if request.n % 2 == 1 {
                            Err(CallError::Invalid)
                        } else {
                            Ok(())
                        }
                    },
                )
                .expect("a zero floor owes nothing");

            let sequencer = sequencer.unwrap();
            (counts, sequencer.shown, handled, sequencer.outcomes)
        })
    });
    r.assert_success();

    let (counts, shown, handled, outcomes) =
        r.assert_return_as::<((u32, u32), Vec<u32>, Vec<u32>, Vec<bool>)>();
    assert_eq!(counts, (5, 2));
    assert_eq!(shown, [0, 1, 2, 3, 4]);
    assert_eq!(handled, [4, 3, 2, 1, 0]);
    assert_eq!(outcomes, [true, false, true, false, true]);
}

// A sequencer that chooses a request twice aborts the crank, and with it the batch: nothing is
// lost, and the whole batch is still queued for the next crank.
#[test]
fn a_sequencer_that_repeats_itself_puts_the_batch_back() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    for n in 0..3 {
        enqueue(&env, n);
    }
    env.advance_block();

    let stuck = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue()
                .crank_sequenced(|| Ok(()), |_: &[Request]| Stuck, |_, _| Ok(()))
                .unwrap()
        })
    });
    assert!(!stuck.is_success());
    env.advance_block();

    assert_eq!(drain_in_order(&env), [0, 1, 2]);
}

// A crank that cannot afford to handle a request, with the sequencer's share, takes none: the
// budget is checked before an entry leaves the queue, as in a plain crank.
#[test]
fn a_crank_that_cannot_afford_a_request_takes_none() {
    let env = TestEnvironment::no_cost();
    initialize(&env);
    for n in 0..3 {
        enqueue(&env, n);
    }
    env.advance_block();

    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            queue()
                .crank_sequenced(|| Ok(()), |_: &[Request]| Dear, |_, _| Ok(()))
                .unwrap()
        })
    });
    r.assert_success();
    assert_eq!(r.assert_return_as::<(u32, u32)>(), (0, 0));
    env.advance_block();

    assert_eq!(drain_in_order(&env), [0, 1, 2]);
}

// The sizing inverts the budget check, as `gas_for_batch` does for a plain crank, with each request
// costing its handling plus the sequencer's share.
#[test]
fn gas_for_sequenced_batch_funds_the_whole_batch() {
    const BATCH: u32 = 4;
    let per_request = Request::GAS_LIMIT + Reverse::GAS_PER_REQUEST;

    assert_eq!(
        gas_for_sequenced_batch::<Request, Reverse>(BATCH),
        EPILOGUE_GAS + CLAIM_GAS + u64::from(BATCH + 1) * per_request
    );
}

/////////////////////// helpers /////////////////////////////////////////////

// A sequencer that is a `&mut` to another, so a test can read it back after the crank.
struct Recording<'a, S>(&'a mut S);

impl<S: Sequencer> Sequencer for Recording<'_, S> {
    const GAS_PER_REQUEST: u64 = S::GAS_PER_REQUEST;

    fn next(&mut self) -> usize {
        self.0.next()
    }

    fn handled(&mut self, ok: bool) {
        self.0.handled(ok)
    }
}

fn queue() -> Queue<Request> {
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

// Enqueue `n` in a block of its own, so that queue order is the order of these calls.
fn enqueue(env: &TestEnvironmentHandle, n: u32) {
    env.transact(|tx| {
        tx.call(&ADDR).run(move || {
            queue().enqueue(|_| Request { n });
        })
    })
    .assert_success();
    env.advance_block();
}

// Drain whatever is queued with a plain crank, returning it in the order it came.
fn drain_in_order(env: &TestEnvironmentHandle) -> Vec<u32> {
    let r = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut seen = Vec::new();
            queue()
                .crank(
                    || Ok(()),
                    |request: Request, _| {
                        seen.push(request.n);
                        Ok(())
                    },
                )
                .unwrap();
            seen
        })
    });
    r.assert_success();
    r.assert_return_as::<Vec<u32>>()
}
