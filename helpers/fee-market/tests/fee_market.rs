//! The fee: its arithmetic, and how a [`FeeMarket`] keeps it.
//!
//! The arithmetic is EIP-1559's: an eighth per block at most, up while the load is above the
//! target, down while it is below. What the market adds is that its callers keep it themselves --
//! every one in a block computes and records the same state -- so the tests below check both that
//! the fee moves as it should across blocks, and that callers in one block never conflict over it.

use fee_market::FeeMarket;
use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([5u8; 32]);

const TARGET: u32 = 2;

// A maximum high enough that the tests not about it never reach it.
const MAX: u64 = 1_000;

// The arithmetic, in whole units, with no maximum but what a `u64` holds.
fn adjust(fee: u64, target: u32, load: u128, blocks: u64) -> u64 {
    adjust_to(fee, target, load, blocks, u64::MAX)
}

fn adjust_to(fee: u64, target: u32, load: u128, blocks: u64, max: u64) -> u64 {
    (fee_market::adjust(u128::from(fee) << 32, target, load, blocks, max) >> 32) as u64
}

// The arithmetic in the fixed point the fee is kept in, block by block, `blocks` times.
fn block_by_block(target: u32, load: u128, blocks: u64, max: u64) -> u64 {
    let mut fee = 0;
    for _ in 0..blocks {
        fee = fee_market::adjust(fee, target, load, 1, max);
    }
    (fee >> 32) as u64
}

/////////////////////// the arithmetic //////////////////////////////////////

// On target, the fee holds.
#[test]
fn on_target_the_fee_holds() {
    assert_eq!(adjust(800, 4, 4, 1), 800);
    assert_eq!(adjust(0, 4, 4, 1), 0);
}

// Twice the target or more raises the fee by an eighth, plus a unit; that is the most one block
// moves it.
#[test]
fn a_full_block_raises_the_fee_by_an_eighth() {
    assert_eq!(adjust(800, 4, 8, 1), 901);
    assert_eq!(adjust(800, 4, 1_000, 1), 901);
}

// An empty block lowers it by an eighth, less a unit.
#[test]
fn an_empty_block_lowers_the_fee_by_an_eighth() {
    assert_eq!(adjust(800, 4, 0, 1), 699);
}

// A free market becomes priced by the unit a block adds, and the eighth takes over as it grows.
#[test]
fn the_fee_rises_from_zero() {
    let fees: Vec<u64> = (1..=10)
        .map(|k| block_by_block(4, 8, k, u64::MAX))
        .collect();
    assert_eq!(fees, vec![1, 2, 3, 4, 6, 8, 10, 12, 15, 17]);
    assert_eq!(
        adjust(800, 4, 5, 1),
        826,
        "a quarter over target raises it by a 32nd, plus a unit"
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
    assert_eq!(adjust(1_000_000, 4, 0, 1_000), 0);
}

// Against a large target, a load just off it still moves the fee by the minimum unit, though the
// ratio itself rounds to one.
#[test]
fn a_large_target_still_moves_the_fee() {
    let target = 1_000_000_000;
    assert_eq!(adjust(0, target, u128::from(target) + 1, 1), 1);
    assert_eq!(adjust(5, target, u128::from(target) - 1, 1), 4);
    assert_eq!(adjust(5, target, u128::from(target), 1), 5);
}

// Several blocks at once come to what as many single blocks do.
#[test]
fn several_blocks_are_several_steps() {
    assert_eq!(adjust(800, 4, 8, 2), 1014);
    assert_eq!(adjust(800, 4, 0, 3), 533);

    // A load just above a target of 1000 adds about a unit a block, compounding slowly.
    let at_once = adjust_to(0, 1000, 1001, 900, 10_000);
    assert_eq!(at_once, 952);
    assert_eq!(at_once, block_by_block(1000, 1001, 900, 10_000));
}

// A gap of any length is computed at once: up to the maximum, or down to zero.
#[test]
fn any_gap_is_computed_at_once() {
    assert_eq!(adjust(0, 4, 8, 1_000_000_000_000), u64::MAX);
    assert_eq!(adjust_to(0, 4, 8, 1_000_000_000_000, 1_000), 1_000);
    assert_eq!(adjust(0, 1000, 1001, 1_000_000_000_000_000), u64::MAX);
    assert_eq!(adjust(u64::MAX, 4, 0, 1_000_000_000_000), 0);
}

// The fee stops at the market's maximum.
#[test]
fn the_fee_is_capped() {
    assert_eq!(adjust_to(5, 4, 8, 10, 7), 7);
    assert_eq!(adjust_to(9, 4, 4, 1, 7), 7, "even on target");
    assert_eq!(adjust(u64::MAX, 4, 8, 1), u64::MAX);
}

/////////////////////// the market ///////////////////////////////////////////

// A new market is free while its load stays at the target, and its first block above it prices it.
#[test]
fn a_new_market_is_free() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    assert_eq!(update(&env, TARGET).assert_return_as::<u64>(), 0);
    env.advance_block();
    assert_eq!(update(&env, 2 * TARGET).assert_return_as::<u64>(), 1);
}

// A target or maximum of zero is refused, and so is a second start, which would reset the fee.
#[test]
fn a_bad_start_is_refused() {
    use fee_market::InitError::*;

    let env = TestEnvironment::no_cost();
    let start = |target: u32, max: u64| {
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

    let fees: Vec<u64> = (0..4)
        .map(|_| {
            let r = update(&env, 2 * TARGET);
            r.assert_success();
            r.assert_return_as::<u64>()
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
    assert_eq!(both.assert_return_as::<[u64; 2]>(), [1, 1]);
}

// The fee follows the load, block by block.
#[test]
fn the_fee_follows_the_load() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    let mut fees = Vec::new();
    for load in [4, 4, 4, 2, 0, 0] {
        fees.push(update(&env, load).assert_return_as::<u64>());
        env.advance_block();
    }

    assert_eq!(fees, vec![1, 2, 3, 3, 1, 0]);
}

// Blocks with no update are each taken to have had the load passed when one next comes: a backlog
// that persists keeps raising the fee, and an empty queue keeps lowering it.
#[test]
fn blocks_without_an_update_are_caught_up() {
    let env = TestEnvironment::no_cost();
    initialize(&env);

    assert_eq!(update(&env, 4).assert_return_as::<u64>(), 1);
    for _ in 0..3 {
        env.advance_block();
    }
    assert_eq!(quote(&env, 4), 4, "three more blocks above target");

    update(&env, 4).assert_success();
    for _ in 0..3 {
        env.advance_block();
    }
    assert_eq!(quote(&env, 0), 0, "three blocks with nothing waiting");
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
fn quote(env: &TestEnvironmentHandle, load: u32) -> u64 {
    let r = env.transact(|tx| tx.call(&ADDR).run(move || market().quote(u128::from(load))));
    r.assert_success();
    r.assert_return_as::<u64>()
}
