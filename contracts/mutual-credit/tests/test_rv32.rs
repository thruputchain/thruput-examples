use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use mutual_credit::*;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::*;

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/mutual_credit.rv32a")
}

// The most gas one transaction may budget, on a network that does not configure it.
const MAX_TX_GAS: u64 = 1_000_000_000;

// The native tokens whoever opens a pair deposits, and each member starts with.
const BOND: i128 = 50_000;
const NATIVE: i64 = 10_000_000;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

// Run `f` as `caller` in the current block, require it to succeed, and return what it returned
// and the gas it spent.
fn metered<R>(env: &TestEnvironmentHandle, caller: &str, f: impl FnOnce() -> R) -> (R, u64)
where
    R: WriteXDR + xdr::ReadXDROwned,
{
    let r = env.transact(|tx| {
        tx.call(&addr(caller)).run(AssertUnwindSafe(|| {
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
/// The largest payment: four routes of six members each, twenty-eight hops, every one of them on
/// a pair a member opened with a bond. Its event carries every route. Then the largest terms, and
/// a close that refunds a bond.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn the_largest_payment_fits_the_guest() {
    let env = TestEnvironment::no_cost();
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let routes: Vec<Vec<String>> = (0..MAX_ROUTES)
        .map(|r| {
            (0..MAX_VIA)
                .map(|m| format!("route-{r}-member-{m}"))
                .collect()
        })
        .collect();
    // Every member on a route opens the pair with the one before it, and the payee with the last.
    let creditors: Vec<String> = routes
        .iter()
        .flatten()
        .cloned()
        .chain(["payee".to_string()])
        .collect();
    for who in creditors.iter().map(|c| addr(c)).chain([addr("founder")]) {
        env.setup_grant_storage_tokens(&who, NATIVE);
    }

    let deployed = env.transact(|tx| {
        tx.call(&addr("founder")).run(move || {
            let credit = deploy_contract(&sha256_static!("credit"), &code);
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&credit, reserve_needed(BOND));
            MutualCreditClient::new(&credit).initialize(BOND);
            credit
        })
    });
    deployed.assert_success();
    let credit = deployed.assert_return_as::<ContractAddress>();
    env.advance_block();
    for creditor in &creditors {
        env.transact(|tx| {
            tx.call(&addr(creditor)).run(move || {
                ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&credit, NATIVE.into())
            })
        })
        .assert_success();
    }
    env.advance_block();

    // Opening a pair takes the bond, and writes its terms and both rooms.
    let client = MutualCreditClient::new(&credit);
    let mut opened = 0;
    for members in &routes {
        let mut debtor = addr("payer");
        for creditor in members.iter().map(String::as_str).chain(["payee"]) {
            let ((), gas) = metered(&env, creditor, || client.set_limit(debtor, 1_000));
            opened = opened.max(gas);
            debtor = addr(creditor);
        }
    }
    eprintln!("set_limit, opening a pair: {opened} gas");
    assert!(opened < MAX_TX_GAS);
    env.advance_block();

    let list = routes
        .iter()
        .map(|members| Route {
            via: VecM(members.iter().map(|m| addr(m)).collect()),
            amount: 100,
        })
        .collect();
    let (paid, gas) = metered(&env, "payer", || client.pay(addr("payee"), VecM(list)));
    let hops = MAX_ROUTES * (MAX_VIA + 1);
    eprintln!("pay, {MAX_ROUTES} routes, {hops} hops: {gas} gas");
    assert!(gas < MAX_TX_GAS);
    assert_eq!(paid, 400);
    env.advance_block();

    let ((), raised) = metered(&env, "payee", || {
        client.set_limit(addr(&routes[0][5]), MAX_LIMIT)
    });
    eprintln!("set_limit, changing a limit: {raised} gas");
    env.advance_block();

    let (line, read) = metered(&env, "viewer", || {
        client.line(addr("payee"), addr(&routes[0][5]))
    });
    eprintln!("line: {read} gas");
    assert_eq!(
        line,
        Line {
            limit: MAX_LIMIT,
            owed: 100,
            room: MAX_LIMIT - 100,
        }
    );

    // A pair nobody has used closes, and its bond goes back.
    let first = addr(&routes[1][0]);
    metered(&env, "payee", || client.set_limit(first, 10));
    env.advance_block();
    metered(&env, "payee", || client.set_limit(first, 0));
    env.advance_block();
    let ((), closed) = metered(&env, "payee", || client.close(first));
    eprintln!("close: {closed} gas");
    assert!(closed < MAX_TX_GAS);
    env.advance_block();

    let r = env.transact(|tx| {
        tx.call(&addr("viewer"))
            .run(move || ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&addr("payee")))
    });
    r.assert_success();
    // The payee opened four pairs on the routes, and the one it closed.
    assert_eq!(r.assert_return_as::<i128>(), i128::from(NATIVE) - 4 * BOND);
}
