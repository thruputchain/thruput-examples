use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use erc20::{ERC20Client, ERC20MetadataClient};
use ladder_auction::*;
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

/// The most a claim does, run as RV32 in the executor: a full ladder, with one bidder at every
/// level of it. Native tests run with the host's memory; this checks that the guest's fixed
/// memory holds the worst case.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn a_claim_across_every_level_fits_the_guest() {
    let env = TestEnvironment::no_cost();
    env.advance_block_at(START.into());
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let token_code = erc20::register_mock_contract(&env);
    let (seller, bidder) = (
        ContractAddress::named("seller"),
        ContractAddress::named("bidder"),
    );
    let levels = MAX_LEVELS as u64;
    let prices: Vec<u64> = (1..=levels).collect();

    let (mut auction, mut sale, mut pay) = (seller, seller, seller);
    env.transact(|tx| {
        tx.call(&seller).run(AssertUnwindSafe(|| {
            sale = deploy_contract(&sha256_static!("sale"), token_code.as_hash());
            pay = deploy_contract(&sha256_static!("pay"), token_code.as_hash());
            for token in [sale, pay] {
                ERC20MetadataClient::new(&token).initialize(&seller, None, None, Some(2));
            }
            ERC20Client::new(&sale).mint(&seller, 1_000);
            ERC20Client::new(&pay).mint(&bidder, 1_000_000);
            auction = deploy_contract(&sha256_static!("auction"), &code);
            ERC20Client::new(&sale).adjust_allowance(&auction, 1_000);
            LadderAuctionClient::new(&auction).initialize(Terms {
                sale_token: sale,
                payment_token: pay,
                lot_size: 1,
                supply: 1_000,
                min_lots: 1,
                prices: VecM(prices.clone()),
                end: END,
                entry_bond: 0,
            });
        }))
    })
    .assert_success();
    env.advance_block();

    env.transact(|tx| {
        tx.call(&bidder).run(move || {
            ERC20Client::new(&pay).adjust_allowance(&auction, 1_000_000);
            let c = LadderAuctionClient::new(&auction);
            for level in 0..levels as u32 {
                c.bid(level, 3);
            }
        })
    })
    .assert_success();
    env.advance_block_at(END.into());

    let claimed = env.transact(|tx| {
        tx.call(&seller).run(move || {
            let c = LadderAuctionClient::new(&auction);
            assert_eq!(c.demand().0, vec![3; levels as usize]);
            let settled = c.claim(&bidder);
            assert_eq!(c.return_unsold(), 1_000 - 3 * levels as i128);
            settled
        })
    });
    claimed.assert_success();

    // Every lot is filled at the reserve, 1 a lot; the rest of each level's escrow comes back.
    let escrow: i128 = prices.iter().map(|p| 3 * i128::from(*p)).sum();
    let lots = 3 * levels as i128;
    assert_eq!(
        claimed.assert_return_as::<Settlement>(),
        Settlement {
            lots,
            paid: lots,
            refund: escrow - lots,
            bonds: 0,
        }
    );
}
