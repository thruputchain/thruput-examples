use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use erc20::{ERC20Client, ERC20MetadataClient};
use ladder_auction::*;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/ladder_auction.rv32a")
}

const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const END: u64 = START + 60 * SECOND;

// Native tokens a bidder deposits for each level it bids at.
const BOND: i128 = 12_000;

// The clearing level: ten full levels sit above it.
const CLEARING: u32 = MAX_LEVELS - 11;

/// The most a claim does, run as RV32 in the executor. Native tests run with the host's memory;
/// this checks that the guest's fixed memory holds the worst case.
///
/// A full ladder, with Alice at every level of it and a bond on each entry. Bob shares the
/// clearing level with her, so it is rationed and rounding leaves a lot over: her claim deletes
/// 32 entries, divides out her share of the rationed level, and makes all four transfers, and
/// `return_unsold` takes its rationed path.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn a_claim_across_every_level_fits_the_guest() {
    let env = TestEnvironment::no_cost();
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let token_code = erc20::register_mock_contract(&env);
    let seller = ContractAddress::named("seller");
    let (alice, bob) = (
        ContractAddress::named("alice"),
        ContractAddress::named("bob"),
    );
    for who in [seller, alice, bob] {
        env.setup_grant_storage_tokens(&who, 10_000_000);
    }
    env.advance_block_at(START.into());

    let levels = MAX_LEVELS as u64;
    let prices: Vec<u64> = (1..=levels).collect();
    // Alice asks for 3 lots at every level, so the ten above the clearing level ask for 30, and
    // the clearing level is left 2 of the 4 lots she and Bob ask for there.
    let supply = 32;

    let (mut auction, mut sale, mut pay) = (seller, seller, seller);
    env.transact(|tx| {
        tx.call(&seller).run(AssertUnwindSafe(|| {
            sale = deploy_contract(&sha256_static!("sale"), token_code.as_hash());
            pay = deploy_contract(&sha256_static!("pay"), token_code.as_hash());
            for token in [sale, pay] {
                ERC20MetadataClient::new(&token).initialize(&seller, None, None, Some(2));
            }
            ERC20Client::new(&sale).mint(&seller, supply);
            for bidder in [alice, bob] {
                ERC20Client::new(&pay).mint(&bidder, 1_000_000);
            }
            auction = deploy_contract(&sha256_static!("auction"), &code);
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN)
                .transfer(&auction, reserve_needed(MAX_LEVELS, BOND));
            ERC20Client::new(&sale).adjust_allowance(&auction, supply);
            LadderAuctionClient::new(&auction).initialize(Terms {
                sale_token: sale,
                payment_token: pay,
                lot_size: 1,
                supply: supply as u64,
                min_lots: 1,
                prices: VecM(prices.clone()),
                end: END,
                entry_bond: BOND,
            });
        }))
    })
    .assert_success();
    env.advance_block();

    for (bidder, bids) in [
        (
            alice,
            (0..MAX_LEVELS).map(|level| (level, 3)).collect::<Vec<_>>(),
        ),
        (bob, vec![(CLEARING, 1)]),
    ] {
        env.transact(|tx| {
            tx.call(&bidder).run(move || {
                ERC20Client::new(&pay).adjust_allowance(&auction, 1_000_000);
                ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&auction, 1_000_000);
                let c = LadderAuctionClient::new(&auction);
                for (level, lots) in bids {
                    c.bid(level, lots);
                }
            })
        })
        .assert_success();
    }
    env.advance_block_at(END.into());

    let claimed = env.transact(|tx| {
        tx.call(&seller).run(move || {
            let c = LadderAuctionClient::new(&auction);
            let clearing = c.clearing();
            assert_eq!(clearing.level, CLEARING);
            assert_eq!((clearing.at_level, clearing.filled_at_level), (4, 2));
            let settled = (c.claim(&alice), c.claim(&bob));
            // Alice's share is 3 * 2 / 4 = 1.5 and Bob's 0.5, both rounded down: one lot over.
            assert_eq!(c.return_unsold(), 1);
            settled
        })
    });
    claimed.assert_success();

    let price = |level: u32| i128::from(prices[level as usize]);
    let escrow: i128 = (0..MAX_LEVELS).map(|level| 3 * price(level)).sum();
    let lots = 30 + 1;
    assert_eq!(
        claimed.assert_return_as::<(Settlement, Settlement)>(),
        (
            Settlement {
                lots,
                paid: lots * price(CLEARING),
                refund: escrow - lots * price(CLEARING),
                bonds: i128::from(MAX_LEVELS) * BOND,
            },
            Settlement {
                lots: 0,
                paid: 0,
                refund: price(CLEARING),
                bonds: BOND,
            }
        )
    );
}
