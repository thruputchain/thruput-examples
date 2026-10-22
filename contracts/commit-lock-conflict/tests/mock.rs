//! The live test's outcomes, reproduced in the mock harness without the race.
//!
//! Two transactions, `A` and `B`, are open in the same block at once, each with
//! its root frame at the same (outer) address. The test runs their calls to the
//! inner probe in an order it chooses, leaving each root frame open between
//! calls, then commits the two in an order it chooses. On a node the order is
//! decided by timing, which is why `tests/live.rs` sees several outcomes for
//! one case.
//!
//! The tests pin down this rule: a commit-locked call that writes a key
//! succeeds only if every *other* transaction holding a lock on that key holds
//! it with the same value. The locks are held until the holding transaction
//! ends -- even if it then fails to commit.
//!
//! So two transactions that write the same sequence of values to a key, each
//! call commit-locked, fault from their second call on once their calls
//! interleave; and a transaction dropped at commit has, in the meantime, made
//! the other's calls fault. Two batch cranks draining the same queue are such a
//! pair.

use std::sync::Mutex;

use commit_lock_conflict::{ProbeClient, register_mock_contract};
use thruput_sdk::sys_exn::bytestring::bytestring_set_exclusive;
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("COMMIT_LOCK_CONFLICT_NONCE");

// The key each transaction may claim exclusively (see `Block::claim`).
const CLAIM: StorageKey = StorageKey::new([0xCC; 32]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tx {
    A,
    B,
}
use Tx::{A, B};

/// One call to the inner probe.
#[derive(Debug, Clone, Copy)]
enum Call {
    /// `bump`, commit-locked: read the counter and write it back incremented.
    Bump,
    /// `bump`, as an ordinary call.
    BumpUnlocked,
    /// `put(value)`, commit-locked: write the counter without reading it.
    Put(u64),
}

/// A block holding two transactions, `A` and `B`.
struct Block {
    /// Each transaction's calls, in the order they run.
    calls: Vec<(Tx, Call)>,
    /// Whether each transaction first writes `CLAIM` exclusively, so that the
    /// two cannot both commit -- as two cranks draining the same queue cannot.
    claim: bool,
    /// Which transaction commits first.
    first_to_commit: Tx,
}

/// What the block did.
#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    /// Each call, in order: `"A ok"`, `"B fault"`, and so on.
    calls: Vec<String>,
    /// Whether `A` and `B` committed (rather than being dropped for a
    /// conflict).
    committed: [bool; 2],
}

// Deploy the inner probe in an earlier block, and return the environment and
// its address.
fn setup() -> (TestEnvironmentHandle, ContractAddress) {
    let env = TestEnvironment::no_cost();
    let hash = *register_mock_contract(&env).as_hash();
    let inner = Mutex::new(None);
    env.transact(|tx| {
        let deployer = <ContractAddress as Named>::named("deployer");
        tx.call(&deployer)
            .run(|| *inner.lock().unwrap() = Some(deploy_contract(&NONCE, &hash)))
    })
    .assert_success();
    env.advance_block();
    let inner = inner.into_inner().unwrap().expect("the probe was deployed");
    (env, inner)
}

impl Block {
    fn run(self) -> Outcome {
        let (env, inner) = setup();
        let outer = <ContractAddress as Named>::named("outer");
        let calls = Mutex::new(Vec::new());

        let mut a = env.transaction().build();
        let mut b = env.transaction().build();
        {
            let root_a = a.open_root_frame(outer).with_invoke_flags(0).build();
            let root_b = b.open_root_frame(outer).with_invoke_flags(0).build();
            if self.claim {
                root_a.execute(|_| {
                    bytestring_set_exclusive(&CLAIM, b"A");
                    FrameAction::Continue
                });
                root_b.execute(|_| {
                    bytestring_set_exclusive(&CLAIM, b"B");
                    FrameAction::Continue
                });
            }

            for (tx, call) in self.calls {
                let root = match tx {
                    Tx::A => &mut *root_a,
                    Tx::B => &mut *root_b,
                };
                root.execute(|_| {
                    let probe = ProbeClient::new(&inner);
                    let result = match call {
                        Call::Bump => probe.with_commit_locking().try_bump(),
                        Call::BumpUnlocked => probe.try_bump(),
                        Call::Put(value) => probe.with_commit_locking().try_put(value),
                    };
                    let outcome = match result {
                        Ok(()) => "ok",
                        Err(CallError::Fault(_)) => "fault",
                        Err(e) => panic!("{tx:?}'s {call:?} failed otherwise: {e:?}"),
                    };
                    calls.lock().unwrap().push(format!("{tx:?} {outcome}"));
                    FrameAction::Continue
                });
            }

            root_a.execute(|_| FrameAction::Close);
            root_b.execute(|_| FrameAction::Close);
        }

        let mut commit = |tx: Tx| {
            let handler = match tx {
                Tx::A => &mut a,
                Tx::B => &mut b,
            };
            match handler.try_commit_transaction() {
                TryCommitResult::Ok => true,
                TryCommitResult::TxNonDeterministicError(_) => false,
                other => panic!("{tx:?} failed to commit otherwise: {other:?}"),
            }
        };
        let (first, second) = match self.first_to_commit {
            Tx::A => (Tx::A, Tx::B),
            Tx::B => (Tx::B, Tx::A),
        };
        let first_committed = commit(first);
        let second_committed = commit(second);
        let committed = match first {
            Tx::A => [first_committed, second_committed],
            Tx::B => [second_committed, first_committed],
        };

        Outcome {
            calls: calls.into_inner().unwrap(),
            committed,
        }
    }
}

// The same `call` once per entry of `order`, by that transaction.
fn bumps(order: &[Tx], call: Call) -> Vec<(Tx, Call)> {
    order.iter().map(|&tx| (tx, call)).collect()
}

fn outcome(calls: &[&str], committed: [bool; 2]) -> Outcome {
    Outcome {
        calls: calls.iter().map(|c| c.to_string()).collect(),
        committed,
    }
}

/// With the calls interleaved, both first bumps write 1, so both transactions
/// hold the counter. Every later bump then writes a value the other does not
/// hold, and faults. Both commit, having written the same value.
#[test]
fn interleaved_bumps_fault_after_the_first() {
    let block = Block {
        calls: bumps(&[A, B, A, B, A, B], Call::Bump),
        claim: false,
        first_to_commit: A,
    };
    let expected = outcome(
        &["A ok", "B ok", "A fault", "B fault", "A fault", "B fault"],
        [true, true],
    );
    assert_eq!(block.run(), expected);
}

/// With A's calls first, A holds the counter at 3 by the time B writes 1, so
/// every one of B's bumps faults.
#[test]
fn the_first_transaction_to_write_keeps_the_key() {
    let block = Block {
        calls: bumps(&[A, A, A, B, B, B], Call::Bump),
        claim: false,
        first_to_commit: A,
    };
    let expected = outcome(
        &["A ok", "A ok", "A ok", "B fault", "B fault", "B fault"],
        [true, true],
    );
    assert_eq!(block.run(), expected);
}

/// The shape of two competing cranks: both claim, so only one can commit. The
/// one dropped still held the counter while the other ran, so the survivor's
/// later bumps faulted -- whichever of the two survives.
#[test]
fn a_dropped_transaction_still_makes_the_survivors_calls_fault() {
    for first_to_commit in [A, B] {
        let block = Block {
            calls: bumps(&[A, B, A, B, A, B], Call::Bump),
            claim: true,
            first_to_commit,
        };
        let expected = outcome(
            &["A ok", "B ok", "A fault", "B fault", "A fault", "B fault"],
            [first_to_commit == A, first_to_commit == B],
        );
        assert_eq!(block.run(), expected);
    }
}

/// Without commit locking, the same competing pair runs every call, and the
/// survivor commits with all of them.
#[test]
fn without_commit_locking_the_survivor_keeps_every_call() {
    let block = Block {
        calls: bumps(&[A, B, A, B, A, B], Call::BumpUnlocked),
        claim: true,
        first_to_commit: A,
    };
    let expected = outcome(
        &["A ok", "B ok", "A ok", "B ok", "A ok", "B ok"],
        [true, false],
    );
    assert_eq!(block.run(), expected);
}

/// Locks held with the same value do not conflict: A and B can write 5 to the
/// counter as often as they like.
#[test]
fn equal_values_share_a_lock() {
    let calls = [A, B, A, B, A, B]
        .into_iter()
        .map(|tx| (tx, Call::Put(5)))
        .collect();
    let block = Block {
        calls,
        claim: false,
        first_to_commit: A,
    };
    let expected = outcome(
        &["A ok", "B ok", "A ok", "B ok", "A ok", "B ok"],
        [true, true],
    );
    assert_eq!(block.run(), expected);
}

/// A transaction alone holding the key may change its value; another, writing
/// a different value, faults each time.
#[test]
fn a_sole_holder_may_change_its_value() {
    let block = Block {
        calls: vec![
            (A, Call::Put(5)),
            (B, Call::Put(9)),
            (A, Call::Put(6)),
            (B, Call::Put(9)),
            (A, Call::Put(7)),
            (B, Call::Put(9)),
        ],
        claim: false,
        first_to_commit: A,
    };
    let expected = outcome(
        &["A ok", "B fault", "A ok", "B fault", "A ok", "B fault"],
        [true, true],
    );
    assert_eq!(block.run(), expected);
}

/// The check is made per call, against the values held at that moment: B's
/// call writing 6 faults while A holds 5, but B's next call, writing 5 again,
/// succeeds.
#[test]
fn each_call_is_checked_against_the_values_held_then() {
    let block = Block {
        calls: vec![
            (A, Call::Put(5)),
            (B, Call::Put(5)),
            (A, Call::Put(5)),
            (B, Call::Put(6)),
            (A, Call::Put(5)),
            (B, Call::Put(5)),
        ],
        claim: false,
        first_to_commit: A,
    };
    let expected = outcome(
        &["A ok", "B ok", "A ok", "B fault", "A ok", "B ok"],
        [true, true],
    );
    assert_eq!(block.run(), expected);
}
