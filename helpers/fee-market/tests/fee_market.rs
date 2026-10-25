//! The fee: its arithmetic, and how a [`FeeMarket`] keeps it.
//!
//! The arithmetic is EIP-1559's: an eighth per block at most, up while the load is above the
//! target, down while it is below. What the market adds is that its callers keep it themselves --
//! every one in a block computes and records the same state -- so the tests below check both that
//! the fee moves as it should across blocks, and that callers in one block never conflict over it.

use fee_market::{FeeMarket, MAX_FEE, MAX_STEPS};
use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([5u8; 32]);

const TARGET: u32 = 2;

// A maximum high enough that the tests not about it never reach it.
const MAX: u128 = 1_000;

// The arithmetic, with no maximum but the global one.
fn adjust(fee: u128, target: u32, load: u128, blocks: u64) -> u128 {
    fee_market::adjust(fee, target, load, blocks, MAX_FEE)
}

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

// A free market becomes priced one unit at a time, until an eighth of the fee is worth a unit.
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

// The fee stops at the market's maximum, and at the global one above any maximum.
#[test]
fn the_fee_is_capped() {
    assert_eq!(fee_market::adjust(5, 4, 8, 10, 7), 7);
    assert_eq!(fee_market::adjust(9, 4, 4, 1, 7), 7, "even on target");
    assert_eq!(adjust(MAX_FEE, 4, 8, 1), MAX_FEE);
    assert_eq!(adjust(MAX_FEE - 1, 4, 8, 10), MAX_FEE);
}

/////////////////////// the market ///////////////////////////////////////////

// A new market is free while its load stays at the target, and its first block above it prices it.
#[test]
fn a_new_market_is_free() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    assert_eq!(update(&env, TARGET).assert_return_as::<u128>(), 0);
    env.advance_block();
    assert_eq!(update(&env, 2 * TARGET).assert_return_as::<u128>(), 1);
}

// A target or maximum of zero is refused, and so is a second start, which would reset the fee.
#[test]
fn a_bad_start_is_refused() {
    use fee_market::InitError::*;

    let env = TestEnvironment::no_cost();
    let start = |target: u32, max: u128| {
        let r = env.transact(|tx| {
            tx.call(&ADDR)
                .run(move || market().initialize(target, max).err().map(|e| e as u32))
        });
        r.assert_success();
        r.assert_return_as::<Option<u32>>()
    };

    assert_eq!(start(0, MAX), Some(ZeroTarget as u32));
    assert_eq!(start(TARGET, 0), Some(ZeroMaxFee as u32));
    assert_eq!(start(TARGET, MAX), None);
    env.advance_block();
    assert_eq!(start(TARGET, MAX), Some(AlreadyInitialized as u32));
}

// Every caller in a block that passes the block's load gets the same fee, and none conflicts with
// another over it, however many there are: each records the same state.
#[test]
fn callers_in_a_block_share_the_fee_without_conflict() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    let fees: Vec<u128> = (0..4)
        .map(|_| {
            let r = update(&env, 2 * TARGET);
            r.assert_success();
            r.assert_return_as::<u128>()
        })
        .collect();
    assert_eq!(fees, vec![1; 4]);
}

// Within a block the fee holds, whatever a later call in the same transaction passes.
#[test]
fn the_fee_holds_within_a_block() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    let both = env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut m = market();
            [m.update(u128::from(2 * TARGET)), m.update(0)]
        })
    });
    both.assert_success();
    assert_eq!(both.assert_return_as::<[u128; 2]>(), [1, 1]);
}

// The fee follows the load, block by block.
#[test]
fn the_fee_follows_the_load() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    let mut fees = Vec::new();
    for load in [4, 4, 4, 2, 0, 0] {
        fees.push(update(&env, load).assert_return_as::<u128>());
        env.advance_block();
    }

    assert_eq!(fees, vec![1, 2, 3, 3, 2, 1]);
}

// Blocks with no update are each taken to have had the load passed when one next comes: a backlog
// that persists keeps raising the fee, and an empty queue keeps lowering it.
#[test]
fn blocks_without_an_update_are_caught_up() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    assert_eq!(update(&env, 4).assert_return_as::<u128>(), 1);
    for _ in 0..3 {
        env.advance_block();
    }
    assert_eq!(quote(&env, 4), 4, "three more blocks above target");

    update(&env, 4).assert_success();
    for _ in 0..3 {
        env.advance_block();
    }
    assert_eq!(quote(&env, 0), 1, "three blocks with nothing waiting");
}

// A load held above the target raises the fee only as far as the maximum.
#[test]
fn a_held_load_stops_at_the_maximum() {
    let env = TestEnvironment::no_cost();
    env.transact(|tx| {
        tx.call(&ADDR)
            .run(|| market().initialize(TARGET, 3).expect("a valid start"))
    })
    .assert_success();
    env.advance_block();

    update(&env, 2 * TARGET).assert_success();
    for _ in 0..10 {
        env.advance_block();
    }
    assert_eq!(quote(&env, 2 * TARGET), 3);
}

/////////////////////// helpers /////////////////////////////////////////////

fn market() -> FeeMarket {
    Keypath::default().into()
}

fn initialize(env: &TestEnvironmentHandle) {
    env.transact(|tx| {
        tx.call(&ADDR)
            .run(|| market().initialize(TARGET, MAX).expect("a valid start"))
    })
    .assert_success();
    env.advance_block();
}

// Record the fee for the current block, given its load, returning the fee.
fn update(env: &TestEnvironmentHandle, load: u32) -> TransactResult {
    env.transact(|tx| {
        tx.call(&ADDR)
            .run(move || market().update(u128::from(load)))
    })
}

// The fee for the current block, given its load.
fn quote(env: &TestEnvironmentHandle, load: u32) -> u128 {
    let r = env.transact(|tx| tx.call(&ADDR).run(move || market().quote(u128::from(load))));
    r.assert_success();
    r.assert_return_as::<u128>()
}
