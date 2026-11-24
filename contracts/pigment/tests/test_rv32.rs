use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use pigment::*;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::*;

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/pigment.rv32a")
}

const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const EPOCH: u64 = 60 * SECOND;

// The most gas one transaction may budget, on a network that does not configure it.
const MAX_TX_GAS: u64 = 1_000_000_000;

const RED: u32 = 0xFF_0000;
const BLUE: u32 = 0x00_00FF;

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
/// The largest canvas is laid out. In the first block of the next epoch, one paint makes the most
/// strokes a paint can, every one of them starting its pixel's coat over, and one repeating a
/// pixel to mix on it. Then the row holding them is read back.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn the_largest_canvas_fits_the_guest() {
    let env = TestEnvironment::no_cost();
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let painter = ContractAddress::named("painter");
    let artist = ContractAddress::named("artist");
    env.setup_grant_storage_tokens(&painter, 10_000_000);
    env.advance_block_at(START.into());

    let (canvas, laid_out) = metered(&env, "deployer", || {
        let canvas = deploy_contract(&sha256_static!("canvas"), &code);
        PigmentClient::new(&canvas).initialize(Terms {
            width: MAX_SIDE,
            height: MAX_SIDE,
            epoch: EPOCH,
            price: 1,
            beneficiary: artist,
        });
        canvas
    });
    eprintln!("initialize, {MAX_SIDE} by {MAX_SIDE}: {laid_out} gas");
    assert!(laid_out < MAX_TX_GAS);

    env.transact(|tx| {
        tx.call(&painter).run(move || {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&canvas, 10_000_000);
        })
    })
    .assert_success();

    // Every slot epoch 1 uses holds the zero it was laid out with, for epoch 0: stale.
    env.advance_block_at((START + EPOCH).into());
    let y = MAX_SIDE - 1;
    let mut strokes: Vec<_> = (0..MAX_STROKES - 1)
        .map(|x| Stroke {
            x,
            y,
            color: RED,
            amount: 1 + x,
        })
        .collect();
    strokes.push(Stroke {
        x: 0,
        y,
        color: BLUE,
        amount: 1,
    });
    let units: i128 = strokes.iter().map(|s| i128::from(s.amount)).sum();
    let (fee, painted) = env
        .transact(|tx| {
            tx.call(&painter).run(AssertUnwindSafe(|| {
                let before = gas_remaining();
                let fee = PigmentClient::new(&canvas).paint(VecM(strokes.clone()));
                (fee, before - gas_remaining())
            }))
        })
        .assert_return_as::<(i128, u64)>();
    eprintln!("paint, {MAX_STROKES} strokes: {painted} gas");
    assert_eq!(fee, units);
    assert!(painted < MAX_TX_GAS);

    env.advance_block_at((START + EPOCH + EPOCH / 2).into());
    let (row, read) = metered(&env, "viewer", || PigmentClient::new(&canvas).row(y));
    eprintln!("row, {MAX_SIDE} pixels: {read} gas");
    let row = row.0;
    assert_eq!(row.len(), MAX_SIDE as usize);
    // Pixel 0 mixes a unit of red with a unit of blue; the rest are red, and the last is blank.
    // All of it is wet.
    assert_eq!(row[0], (0x7F_007F << 8) | 255);
    assert!(
        row[1..MAX_STROKES as usize - 1]
            .iter()
            .all(|p| *p == (RED << 8) | 255)
    );
    assert_eq!(row[MAX_SIDE as usize - 1], 0);
}
