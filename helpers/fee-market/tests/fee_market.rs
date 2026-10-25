//! The entry fee: its arithmetic, and how a [`FeeMarket`] keeps it.
//!
//! The arithmetic is EIP-1559's: an eighth per block at most, up while entries exceed the target,
//! down while they fall short. What the market adds is that the entries keep it themselves -- every
//! one in a block computes and writes the same state -- so the tests below check both that the fee
//! moves as it should across blocks, and that entries in one block never conflict over it.

use fee_market::{FeeMarket, MAX_FEE, MAX_STEPS, adjust};
use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([5u8; 32]);

const TARGET: u32 = 2;

/////////////////////// the arithmetic //////////////////////////////////////

// On target, the fee holds.
#[test]
fn on_target_the_fee_holds() {
    assert_eq!(adjust(800, 4, 4, 1), 800);
    assert_eq!(adjust(0, 4, 4, 1), 0);
}

// Twice the target or more raises the fee by an eighth; that is the most one block moves it.
#[test]
fn a_full_block_raises_the_fee_by_an_eighth() {
    assert_eq!(adjust(800, 4, 8, 1), 900);
    assert_eq!(adjust(800, 4, 1_000, 1), 900);
}

// An empty block lowers it by an eighth.
#[test]
fn an_empty_block_lowers_the_fee_by_an_eighth() {
    assert_eq!(adjust(800, 4, 0, 1), 700);
}

// A free queue becomes priced one unit at a time, until an eighth of the fee is worth a unit.
#[test]
fn the_fee_rises_from_zero() {
    let mut fee = 0;
    for expected in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] {
        fee = adjust(fee, 4, 8, 1);
        assert_eq!(fee, expected);
    }
    assert_eq!(
        adjust(800, 4, 5, 1),
        825,
        "a quarter over target raises it by a 32nd"
    );
}

// And a quiet one gets back to free.
#[test]
fn the_fee_falls_to_zero() {
    assert_eq!(
        adjust(1, 4, 3, 1),
        0,
        "any shortfall takes off at least a unit"
    );
    assert_eq!(adjust(1_000_000, 4, 0, MAX_STEPS), 0);
}

// Several blocks are several steps.
#[test]
fn several_blocks_are_several_steps() {
    assert_eq!(adjust(800, 4, 8, 2), adjust(adjust(800, 4, 8, 1), 4, 8, 1));
    assert_eq!(adjust(800, 4, 8, 2), 1012);
    assert_eq!(adjust(800, 4, 0, 3), 535);
}

// The fee stops at its ceiling.
#[test]
fn the_fee_is_capped() {
    assert_eq!(adjust(MAX_FEE, 4, 8, 1), MAX_FEE);
    assert_eq!(adjust(MAX_FEE - 1, 4, 8, 10), MAX_FEE);
}

/////////////////////// the market ///////////////////////////////////////////

// A new market is free to enter.
#[test]
fn a_new_market_is_free() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    assert_eq!(enter(&env).assert_return_as::<u128>(), 0);
}

// A target of zero is refused, and so is a second start, which would reset the fee.
#[test]
fn a_bad_start_is_refused() {
    let env = TestEnvironment::no_cost();
    let zero = env.transact(|tx| tx.call(&ADDR).run(|| market().initialize(0).is_ok()));
    zero.assert_success();
    assert!(!zero.assert_return_as::<bool>());

    initialize(&env);
    let again = env.transact(|tx| tx.call(&ADDR).run(|| market().initialize(TARGET).is_ok()));
    again.assert_success();
    assert!(!again.assert_return_as::<bool>());
}

// Every entry in a block pays the same fee, and none conflicts with another over it, however many
// there are: each writes the same state.
#[test]
fn entries_in_a_block_share_the_fee_without_conflict() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    // A busy block, then the fee it earned.
    for _ in 0..2 * TARGET {
        enter(&env).assert_success();
    }
    env.advance_block();

    let fees: Vec<u128> = (0..2 * TARGET)
        .map(|_| {
            let r = enter(&env);
            r.assert_success();
            r.assert_return_as::<u128>()
        })
        .collect();
    assert_eq!(fees, vec![1; fees.len()]);
}

// Two entries in one transaction pay the same fee, and the second counts toward the next block
// like the first.
#[test]
fn entries_in_one_transaction_share_the_fee() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    let both = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut m = market();
            (0..2 * TARGET).map(|_| m.enter()).collect::<Vec<u128>>()
        })
    });
    both.assert_success();
    assert_eq!(
        both.assert_return_as::<Vec<u128>>(),
        vec![0; 2 * TARGET as usize]
    );

    env.advance_block();
    assert_eq!(quote(&env), 1);
}

// The fee follows the entries of the block before, block by block.
#[test]
fn the_fee_follows_each_block_s_entries() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    // Each block is quoted the fee its predecessor's entries earned.
    let mut quoted = Vec::new();
    for entries in [4, 4, 4, 2, 0, 0] {
        quoted.push(quote(&env));
        for _ in 0..entries {
            enter(&env).assert_success();
        }
        env.advance_block();
    }
    quoted.push(quote(&env));

    assert_eq!(quoted, vec![0, 1, 2, 3, 3, 2, 1]);
}

// Blocks with no entry at all are accounted for by the next one.
#[test]
fn quiet_blocks_are_caught_up() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    for _ in 0..3 {
        for _ in 0..2 * TARGET {
            enter(&env).assert_success();
        }
        env.advance_block();
    }
    assert_eq!(quote(&env), 3);

    // Two blocks pass with nothing entering: each takes an eighth off, as it would had it been
    // recorded.
    env.advance_block();
    env.advance_block();
    assert_eq!(quote(&env), 1);
}

/////////////////////// helpers /////////////////////////////////////////////

fn market() -> FeeMarket {
    Keypath::default().into()
}

fn initialize(env: &TestEnvironmentHandle) {
    env.transact(|tx| {
        tx.call(&ADDR)
            .run(|| market().initialize(TARGET).expect("a nonzero target"))
    })
    .assert_success();
    env.advance_block();
}

// Make one entry, returning the fee it was charged.
fn enter(env: &TestEnvironmentHandle) -> TransactResult {
    env.transact(|tx| tx.call(&ADDR).run(|| market().enter()))
}

// What an entry costs in the current block.
fn quote(env: &TestEnvironmentHandle) -> u128 {
    let r = env.transact(|tx| tx.call(&ADDR).run(|| market().quote()));
    r.assert_success();
    r.assert_return_as::<u128>()
}
