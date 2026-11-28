use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use erc20::{ERC20Client, ERC20MetadataClient};
use stream::*;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::*;

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/stream.rv32a")
}

const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000;

// The most gas one transaction may budget, on a network that does not configure it.
const MAX_TX_GAS: u64 = 1_000_000_000;

// Native tokens a payer deposits for each item its stream creates.
const BOND: i128 = 13_000;

const FUNDS: i128 = 1_000_000_000;

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
/// Alice opens the first stream to Bob, ending at a second whose path up the tree is 31 nodes
/// long, so the open creates Bob's totals and 62 nodes, and bonds every one. She opens a second
/// such stream and cancels it partway, which takes back 62 nodes and makes three transfers. Then
/// the clock jumps to the last second the tree holds, where a prefix sum reads a node at every
/// level: Bob withdraws there, reading all 64.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn the_deepest_paths_fit_the_guest() {
    let env = TestEnvironment::no_cost();
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let token_code = erc20::register_mock_contract(&env);
    let (deployer, alice) = (
        ContractAddress::named("deployer"),
        ContractAddress::named("alice"),
    );
    for who in [deployer, alice] {
        env.setup_grant_storage_tokens(&who, 10_000_000);
    }
    env.advance_block_at((START * SECOND).into());

    let (mut stream, mut token) = (deployer, deployer);
    env.transact(|tx| {
        tx.call(&deployer).run(AssertUnwindSafe(|| {
            token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
            ERC20MetadataClient::new(&token).initialize(&deployer, None, None, Some(2));
            ERC20Client::new(&token).mint(&alice, FUNDS);
            stream = deploy_contract(&sha256_static!("stream"), &code);
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&stream, reserve_needed(BOND));
            StreamClient::new(&stream).initialize(Terms {
                token,
                item_bond: BOND,
            });
        }))
    })
    .assert_success();
    env.advance_block_at(((START + 1) * SECOND).into());
    env.transact(|tx| {
        tx.call(&alice).run(move || {
            ERC20Client::new(&token).adjust_allowance(&stream, FUNDS);
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&stream, 10_000_000);
        })
    })
    .assert_success();
    env.advance_block_at(((START + 2) * SECOND).into());

    // Ending at second 1024 is node 1025, whose path is 1025, 1026, 1028, ..., 1536, 2048, ...,
    // 2^31: 31 nodes. So is second 2^20's.
    let client = StreamClient::new(&stream);
    let bob = ContractAddress::named("bob");
    let native_before = native(&env, alice);
    let (_, opened) = metered(&env, "alice", || client.open(&bob, 1, 3, 1_024 - 2));
    eprintln!("open, a new payee, 62 new nodes: {opened} gas");
    assert!(opened < MAX_TX_GAS);
    env.advance_block_at(((START + 3) * SECOND).into());
    assert_eq!(
        native_before - native(&env, alice),
        (1 + 4 + 2 * 31) * BOND,
        "a record, Bob's four totals, and 31 nodes in each tree"
    );

    metered(&env, "alice", || client.open(&bob, 2, 5, (1 << 20) - 3));
    env.advance_block_at(((START + 500) * SECOND).into());
    let (cancellation, cancelled) = metered(&env, "alice", || client.cancel(2));
    eprintln!("cancel, 62 nodes: {cancelled} gas");
    assert!(cancelled < MAX_TX_GAS);
    assert_eq!(
        cancellation,
        Cancellation {
            paid: 5 * 497,
            refund: 5 * ((1 << 20) - 500),
        }
    );

    // Second `MAX_INDEX` is node 2^32 - 1, every bit set: a prefix sum there reads a node at every
    // level.
    env.advance_block_at(((START + u64::from(fenwick::MAX_INDEX)) * SECOND).into());
    let (owed, read) = metered(&env, "viewer", || client.owed(&bob));
    eprintln!("owed, 64 nodes: {read} gas");
    assert_eq!(owed, 3 * 1_022 + 5 * 497);

    let (paid, withdrew) = metered(&env, "bob", || client.withdraw());
    eprintln!("withdraw, 64 nodes: {withdrew} gas");
    assert!(withdrew < MAX_TX_GAS);
    assert_eq!(paid, owed);
}

fn native(env: &TestEnvironmentHandle, holder: ContractAddress) -> i128 {
    let r = env.transact(|tx| {
        tx.call(&ContractAddress::named("viewer"))
            .run(move || ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&holder))
    });
    r.assert_success();
    r.assert_return_as::<i128>()
}
