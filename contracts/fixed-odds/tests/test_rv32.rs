use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use erc20::{ERC20Client, ERC20MetadataClient};
use fixed_odds::*;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::*;

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/fixed_odds.rv32a")
}

const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const CLOSE: u64 = START + 3_600 * SECOND;

// The most gas one transaction may budget, on a network that does not configure it.
const MAX_TX_GAS: u64 = 1_000_000_000;

// Native tokens a bettor deposits for each outcome it bets on.
const BOND: i128 = 24_000;

const FUNDS: i128 = 1_000_000_000;
const BANKROLL: i128 = 1_000_000;

// Run `f` as `caller` in the current block, require it to succeed, and return what it returned
// and the gas it spent.
fn metered<R>(env: &TestEnvironmentHandle, caller: &str, f: impl FnOnce() -> R) -> (R, u64)
where
    R: WriteXDR + xdr::ReadXDROwned,
{
    let r = env.transact(|tx| {
        tx.call(&ContractAddress::named(caller))
            .run(AssertUnwindSafe(|| {
                let before = gas_remaining();
                let returned = f();
                (returned, before - gas_remaining())
            }))
    });
    r.assert_success();
    r.assert_return_as::<(R, u64)>()
}

/// The most each method does, run as RV32 in the executor. Native tests run with the host's
/// memory and no gas metering; this checks that the guest's fixed memory holds the worst case,
/// and that it fits in one transaction's gas.
///
/// A market on the most outcomes there can be, with a bond on every position. Alice opens a
/// position on every outcome, so a bet writes every headroom and her claim deletes every position
/// and makes both its transfers. The house withdraws, which takes from every case, and settles.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn the_largest_market_fits_the_guest() {
    let env = TestEnvironment::no_cost();
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let token_code = erc20::register_mock_contract(&env);
    let (house, alice) = (
        ContractAddress::named("house"),
        ContractAddress::named("alice"),
    );
    for who in [house, alice] {
        env.setup_grant_storage_tokens(&who, 10_000_000);
    }
    env.advance_block_at(START.into());

    let outcomes = MAX_OUTCOMES;
    let odds = 8 * ODDS_ONE;
    let (mut book, mut token) = (house, house);
    env.transact(|tx| {
        tx.call(&house).run(AssertUnwindSafe(|| {
            token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
            ERC20MetadataClient::new(&token).initialize(&house, None, None, Some(2));
            for who in [house, alice] {
                ERC20Client::new(&token).mint(&who, FUNDS);
            }
            book = deploy_contract(&sha256_static!("book"), &code);
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&book, reserve_needed(outcomes, BOND));
            ERC20Client::new(&token).adjust_allowance(&book, FUNDS);
            FixedOddsClient::new(&book).initialize(
                Terms {
                    token,
                    resolver: ContractAddress::named("resolver"),
                    outcomes,
                    close: CLOSE,
                    resolve_by: CLOSE + 3_600 * SECOND,
                    min_stake: 1,
                    entry_bond: BOND,
                },
                BANKROLL,
                VecM(vec![odds; outcomes as usize]),
            );
        }))
    })
    .assert_success();
    env.advance_block();
    env.transact(|tx| {
        tx.call(&alice).run(move || {
            ERC20Client::new(&token).adjust_allowance(&book, FUNDS);
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&book, 10_000_000);
        })
    })
    .assert_success();
    env.advance_block();

    // Each bet opens a position, takes the bond, and writes every outcome's headroom.
    let client = FixedOddsClient::new(&book);
    let mut opened = 0;
    for outcome in 0..outcomes {
        let (payout, gas) = metered(&env, "alice", || client.bet(outcome, 100, odds));
        assert_eq!(payout, 800);
        opened = opened.max(gas);
    }
    eprintln!("bet, {outcomes} outcomes, opening a position: {opened} gas");
    assert!(opened < MAX_TX_GAS);
    env.advance_block();

    // Every outcome is down 700 and up 7 * 100: the book is balanced.
    let (headroom, read) = metered(&env, "viewer", || client.headroom());
    eprintln!("headroom, {outcomes} outcomes: {read} gas");
    assert_eq!(headroom.outcomes.0, vec![BANKROLL; outcomes as usize]);
    assert_eq!(headroom.void, BANKROLL);

    let ((), withdrew) = metered(&env, "house", || client.withdraw(BANKROLL / 2));
    eprintln!("withdraw, {} cases: {withdrew} gas", outcomes + 1);
    assert!(withdrew < MAX_TX_GAS);

    env.advance_block_at(CLOSE.into());
    env.transact(|tx| {
        tx.call(&ContractAddress::named("resolver"))
            .run(move || FixedOddsClient::new(&book).resolve(outcomes - 1))
    })
    .assert_success();
    env.advance_block();

    let (claim, claimed) = metered(&env, "anyone", || client.claim(&alice));
    eprintln!("claim, {outcomes} positions: {claimed} gas");
    assert!(claimed < MAX_TX_GAS);
    assert_eq!(
        claim,
        Claim {
            paid: 800,
            bonds: i128::from(outcomes) * BOND,
        }
    );

    let (kept, settled) = metered(&env, "anyone", || client.settle());
    eprintln!("settle: {settled} gas");
    assert_eq!(kept, BANKROLL / 2);
    env.advance_block();

    // Alice staked 800 and was paid 800; the house kept what it did not withdraw. The book holds
    // nothing.
    let r = env.transact(|tx| {
        tx.call(&ContractAddress::named("viewer")).run(move || {
            [book, alice, house].map(|who| ERC20Client::new(&token).get_balance_of(&who))
        })
    });
    r.assert_success();
    assert_eq!(r.assert_return_as::<[i128; 3]>(), [0, FUNDS, FUNDS]);
}
