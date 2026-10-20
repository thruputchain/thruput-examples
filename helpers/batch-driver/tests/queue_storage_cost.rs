//! What a driver's queue costs to hold.
//!
//! A queued entry is a storage deposit locked out of the driver contract's own HOG balance, and
//! that deposit is what [`CapacityConstraint`](thruput_sdk::storage::CapacityConstraint) exists to bound.
//! How big a ceiling is affordable depends on the price, so this measures it: under the default
//! cost model an entry is *flat and cheap*, whatever it contains, over a fixed cost for the queue
//! itself.
//!
//! The consequence is worth knowing before choosing a ceiling: at these prices storage is not what
//! limits how deep a queue should be allowed to get. A contract funded the way this repository
//! funds one could hold a queue of millions. The ceiling is really about how long a request
//! admitted to the back of the queue would have to wait -- and about the fact that, once admitted,
//! it cannot be taken back.

use thruput_sdk::storage::*;
use thruput_sdk::*;

const ADDR: ContractAddress = ContractAddress::new([9u8; 32]);

// Measured against the default cost model, for entries inserted by one transaction. Spread across
// transactions the fixed part is twice this; the per-entry charge is the same either way.
const QUEUE_FIXED_COST: i64 = 12_000;
const COST_PER_ENTRY: i64 = 8;

// A queue holds at most this many entries per block of its own (the protocol's
// `kRetrocausalQueueBlockEntriesMaxLen`). Past it the price stops being the straight line measured
// here, so the figures below stay inside one block.
const ENTRIES_PER_QUEUE_BLOCK: u32 = 250;

// Insert `entries` entries of `size` bytes each, in one transaction, into a queue whose contract
// holds `grant`. Reports whether the deposit was affordable.
fn affordable(grant: i64, entries: u32, size: usize) -> bool {
    let env = thruput_sdk::TestEnvironment::new(None); // default cost model
    env.setup_grant_storage_tokens(&ADDR, grant);

    env.transact(|tx| {
        tx.call(&ADDR).run(|| {
            let mut q: RCQ<()> = Keypath::default().into();
            for _ in 0..entries {
                match size {
                    8 => q.insert_raw(&[0u8; 8]),
                    _ => q.insert_raw(&[0u8; 256]),
                }
            }
        })
    })
    .is_success()
}

fn cost_of(entries: u32) -> i64 {
    QUEUE_FIXED_COST + COST_PER_ENTRY * i64::from(entries)
}

// The price is a fixed cost for the queue plus a flat charge per entry: fund a contract with
// exactly that and the entries fit; a shade less and they do not.
#[test]
fn a_queue_costs_a_fixed_amount_plus_a_flat_charge_per_entry() {
    for entries in [1u32, 10, 100, ENTRIES_PER_QUEUE_BLOCK] {
        let cost = cost_of(entries);
        assert!(
            affordable(cost, entries, 8),
            "{entries} entries should fit a deposit of {cost}"
        );
        assert!(
            !affordable(cost - 1, entries, 8),
            "{entries} entries should not fit a deposit of {}",
            cost - 1
        );
    }
}

// The charge is per entry, not per byte: a 256-byte entry -- the protocol's maximum -- costs what
// an 8-byte one does.
#[test]
fn an_entry_costs_the_same_whatever_it_holds() {
    let cost = cost_of(100);
    assert!(affordable(cost, 100, 256));
    assert!(!affordable(cost - 1, 100, 256));
}

// Which makes storage a poor reason to keep a ceiling low. A driver funded the way this repository
// funds a pool contract could hold a queue orders of magnitude deeper than any it should actually
// admit -- so a ceiling has to be justified by something else.
#[test]
fn storage_is_not_what_limits_a_sensible_ceiling() {
    // `apps/swap`'s setup funds each pool contract with this much.
    const POOL_FUNDING: i64 = 10_000_000;

    let affordable_entries = (POOL_FUNDING - 2 * QUEUE_FIXED_COST) / COST_PER_ENTRY;
    assert!(
        affordable_entries > 1_000_000,
        "a pool contract's funding covers {affordable_entries} entries"
    );
}
