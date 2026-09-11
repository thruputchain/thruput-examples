//! [`UniqueIds`]: that the ids really are distinct.
//!
//! An id is the submitting transaction's hash and a counter, hashed together, and the two halves
//! cover different cases: the counter separates ids minted within one transaction, the transaction
//! hash separates ids minted in different ones -- including concurrent transactions in a single
//! block, which observe the same counter because neither can see the other's delta.
//!
//! Only the counter's half is testable here. The native harness reports a source transaction hash
//! of all zeros, in every transaction and every block (probed while writing these), so natively the
//! two halves are one: ids differ here exactly when the counter does. What that costs is the
//! ability to test the case the counter alone gets wrong -- two transactions in one block -- which
//! needs a real node, where the hashes actually differ. It is worth knowing before reading a
//! passing run as proof of more than it shows.

use sdk::storage::*;
use sdk::*;
use unique_ids::UniqueIds;

const ADDR: ContractAddress = ContractAddress::new([5u8; 32]);

// Within one transaction, where the transaction hash is shared even on a real node, the counter is
// the whole of what keeps them apart.
#[test]
fn ids_minted_in_one_transaction_differ() {
    let env = TestEnvironment::no_cost();

    let ids = mint(&env, 3);
    assert_eq!(distinct(&ids), 3, "{ids:?}");
}

// The counter is committed state, so it carries across blocks rather than restarting.
#[test]
fn ids_keep_differing_across_blocks() {
    let env = TestEnvironment::no_cost();

    let first = mint(&env, 2);
    env.advance_block();
    let second = mint(&env, 2);

    let all: Vec<_> = first.iter().chain(second.iter()).copied().collect();
    assert_eq!(distinct(&all), 4, "{all:?}");
}

// Minting never reads the counter against the snapshot -- it is a blind delta -- so concurrent
// minters do not conflict with each other. This is the property that lets a contract accept
// submissions from many transactions in one block; a read-add-write counter would serialize them
// one per block.
#[test]
fn concurrent_mints_do_not_conflict() {
    let env = TestEnvironment::no_cost();

    mint_result(&env, 1).assert_success();
    mint_result(&env, 1).assert_success();
}

// helpers //

fn ids() -> Node<UniqueIds> {
    Keypath::default().into()
}

fn mint_result(env: &TestEnvironmentHandle, count: usize) -> TransactResult {
    env.transact(move |tx| {
        tx.call(&ADDR).run(move || {
            let mut ids = ids();
            (0..count).map(|_| ids.next_id()).collect::<Vec<_>>()
        })
    })
}

fn mint(env: &TestEnvironmentHandle, count: usize) -> Vec<SHA256Hash> {
    let r = mint_result(env, count);
    r.assert_success();
    r.assert_return_as::<Vec<SHA256Hash>>()
}

fn distinct(ids: &[SHA256Hash]) -> usize {
    let mut seen = ids.to_vec();
    seen.sort_by(|a, b| a.as_ref().cmp(b.as_ref()));
    seen.dedup();
    seen.len()
}
