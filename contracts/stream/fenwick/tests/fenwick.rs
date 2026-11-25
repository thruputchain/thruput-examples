//! The tree: its sums against a plain array's, and how adds from many transactions in one block
//! combine.

use fenwick::{Fenwick, LEVELS, MAX_INDEX, OutOfRange};
use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([5u8; 32]);

fn tree() -> Fenwick {
    Keypath::default().into()
}

// Run `f` on the tree in its own transaction, and require it to commit.
fn with_tree<R>(env: &TestEnvironmentHandle, f: impl FnOnce(&mut Fenwick) -> R) -> R
where
    R: WriteXDR + xdr::ReadXDROwned,
{
    let r = env.transact(|tx| {
        tx.call(&ADDR)
            .run(std::panic::AssertUnwindSafe(|| f(&mut tree())))
    });
    r.assert_success();
    r.assert_return_as::<R>()
}

fn prefix_sums(env: &TestEnvironmentHandle, indices: &[u32]) -> Vec<i128> {
    let indices = indices.to_vec();
    with_tree(env, move |t| {
        indices.iter().map(|&i| t.prefix_sum(i)).collect::<Vec<_>>()
    })
}

// Execute an add in the current block without committing it.
fn pending_add(env: &TestEnvironmentHandle, index: u32, amount: i128) -> MockTransactionHandler {
    let mut tx = env.transaction().build();
    tx.call(&ADDR)
        .run(move || tree().add(index, amount).expect("in range"))
        .assert_success();
    tx
}

// A small deterministic generator, so the tests need no dependency.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

// Indices clustered near zero, as a contract's clock would leave them, with a few anywhere.
fn some_index(rng: &mut Lcg) -> u32 {
    if rng.below(4) == 0 {
        rng.next() as u32 % (MAX_INDEX + 1)
    } else {
        rng.below(5_000) as u32
    }
}

// Over many blocks of adds and subtracts, every prefix sum is what a plain array's would be.
#[test]
fn prefix_sums_match_a_plain_array() {
    let env = TestEnvironment::no_cost();
    let mut rng = Lcg(7);
    let mut added: Vec<(u32, i128)> = Vec::new();

    for _ in 0..12 {
        // Add some amounts, and take back some added in earlier blocks.
        let mut adds = Vec::new();
        for _ in 0..6 {
            adds.push((some_index(&mut rng), 1 + rng.below(1_000) as i128));
        }
        let mut subtracts = Vec::new();
        for _ in 0..2 {
            if !added.is_empty() {
                subtracts.push(added.swap_remove(rng.below(added.len() as u64) as usize));
            }
        }
        let (a, s) = (adds.clone(), subtracts.clone());
        with_tree(&env, move |t| {
            for (index, amount) in a {
                t.add(index, amount).expect("in range");
            }
            for (index, amount) in s {
                t.subtract(index, amount).expect("in range");
            }
        });
        added.extend(adds);
        env.advance_block();

        let mut probes: Vec<u32> = (0..8).map(|_| some_index(&mut rng)).collect();
        probes.extend(added.iter().map(|(index, _)| *index));
        probes.extend([0, MAX_INDEX, u32::MAX]);
        let expected: Vec<i128> = probes
            .iter()
            .map(|&p| added.iter().filter(|(i, _)| *i <= p).map(|(_, a)| a).sum())
            .collect();
        assert_eq!(prefix_sums(&env, &probes), expected);
    }
}

// Forty adds in one block, all executed before any commits, then committed: forward in one tree,
// and backward in another. Every add commits, and the trees agree, at every index.
#[test]
fn adds_in_one_block_commute() {
    let mut rng = Lcg(11);
    let adds: Vec<(u32, i128)> = (0..40)
        .map(|_| (rng.below(64) as u32, 1 + rng.below(100) as i128))
        .collect();

    let committed = |backward: bool| {
        let env = TestEnvironment::no_cost();
        let mut txs: Vec<_> = adds
            .iter()
            .map(|&(index, amount)| pending_add(&env, index, amount))
            .collect();
        if backward {
            txs.reverse();
        }
        for tx in &mut txs {
            assert_eq!(tx.try_commit_transaction(), TryCommitResult::Ok);
        }
        drop(txs);
        env.advance_block();
        prefix_sums(&env, &(0..70).collect::<Vec<_>>())
    };

    let forward = committed(false);
    assert_eq!(forward, committed(true));
    let expected: Vec<i128> = (0..70)
        .map(|p| adds.iter().filter(|(i, _)| *i <= p).map(|(_, a)| a).sum())
        .collect();
    assert_eq!(forward, expected);
}

// An add reads nothing, so it never sees another add in its block -- not even its prefix sums.
#[test]
fn a_prefix_sum_sees_the_block_start() {
    let env = TestEnvironment::no_cost();
    with_tree(&env, |t| t.add(3, 5).expect("in range"));
    env.advance_block();

    let mut add = pending_add(&env, 2, 7);
    assert_eq!(prefix_sums(&env, &[3]), vec![5]);
    assert_eq!(add.try_commit_transaction(), TryCommitResult::Ok);
    drop(add);

    env.advance_block();
    assert_eq!(prefix_sums(&env, &[1, 2, 3]), vec![0, 7, 12]);
}

// Each node holds at least what was added beneath it, so taking back what was added is always
// safe. Taking it back twice is not: the runtime turns away the second subtract.
#[test]
fn a_subtract_takes_back_only_what_was_added() {
    let env = TestEnvironment::no_cost();
    with_tree(&env, |t| t.add(9, 5).expect("in range"));
    env.advance_block();

    let subtract = |env: &TestEnvironmentHandle| {
        let mut tx = env.transaction().build();
        tx.call(&ADDR)
            .run(|| tree().subtract(9, 5).expect("in range"))
            .assert_success();
        tx
    };
    let (mut first, mut second) = (subtract(&env), subtract(&env));
    assert_eq!(first.try_commit_transaction(), TryCommitResult::Ok);
    assert_ne!(second.try_commit_transaction(), TryCommitResult::Ok);
    drop((first, second));

    env.advance_block();
    assert_eq!(prefix_sums(&env, &[9, MAX_INDEX]), vec![0, 0]);
}

// An add writes one node a level, and creates whichever of them nobody has written yet: all 32 in
// an empty tree from index 0, and none for an index whose path the tree already holds.
#[test]
fn an_add_creates_only_the_nodes_it_is_first_to_reach() {
    let env = TestEnvironment::no_cost();
    let missing = |env: &TestEnvironmentHandle, index: u32| {
        with_tree(env, move |t| t.missing_nodes(index).expect("in range"))
    };

    assert_eq!(missing(&env, 0), LEVELS);
    assert_eq!(missing(&env, MAX_INDEX), 1, "the root's range is the top");

    with_tree(&env, |t| t.add(0, 1).expect("in range"));
    env.advance_block();

    // Index 1 shares every node above its own with index 0, and its own is index 0's second.
    assert_eq!(missing(&env, 1), 0);
    // Index 2 needs its own node; the rest of its path is index 0's.
    assert_eq!(missing(&env, 2), 1);
    assert_eq!(missing(&env, 4096), 12);
}

// The domain runs from 0 to `MAX_INDEX`; a prefix sum past it is the sum of everything.
#[test]
fn the_ends_of_the_range() {
    let env = TestEnvironment::no_cost();
    with_tree(&env, |t| {
        t.add(MAX_INDEX, 3).expect("in range");
        t.add(0, 4).expect("in range");
    });
    env.advance_block();

    assert_eq!(
        prefix_sums(&env, &[0, MAX_INDEX - 1, MAX_INDEX, u32::MAX]),
        vec![4, 4, 7, 7]
    );
    let refused = with_tree(&env, |t| {
        (t.add(u32::MAX, 1) == Err(OutOfRange)) && (t.missing_nodes(u32::MAX) == Err(OutOfRange))
    });
    assert!(refused);
}
