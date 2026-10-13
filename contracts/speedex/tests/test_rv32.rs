//! The exchange compiled to RV32 and run by the mock executor -- the same path as on chain.
//!
//! `cargo test` runs the contract natively; this runs the artifact `thruput build` produced, so a
//! fault in the clearing arithmetic (an overflow, a panic) is a real abort here. Run via
//! `thruput test -p speedex`, after building `speedex` and `erc20`.

use sdk::*;
use speedex::engine::{self, Grid, PRICE_ONE};
use speedex::*;
use thruput_erc20_if::ERC20Client;

hash_ident! { static TEST: ContractAddress; }
hash_ident! { static ALICE: ContractAddress; }
hash_ident! { static BOB: ContractAddress; }
hash_ident! { static CAROL: ContractAddress; }
hash_ident! { static TOKEN_A_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_B_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_C_NONCE: SHA256Hash; }
hash_ident! { static EXCHANGE_NONCE: SHA256Hash; }
hash_ident! { static BIG_EXCHANGE_NONCE: SHA256Hash; }

const UNIT: u128 = 1_000_000;

fn run<T>(env: &TestEnvironmentHandle, who: &ContractAddress, f: impl Fn() -> T) -> T {
    use std::sync::{Arc, Mutex};
    let f = std::panic::AssertUnwindSafe(f);
    let out = Arc::new(Mutex::new(None));
    env.transact(|tx| {
        tx.call(who).run(|| {
            *Arc::clone(&out).lock().unwrap() = Some((*f)());
        })
    })
    .assert_success();
    Arc::into_inner(out).unwrap().into_inner().unwrap().unwrap()
}

#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn ring_trade_rv32() {
    let env = TestEnvironment::no_cost();
    let token_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/thruput/erc20.rv32a"));
    let exchange_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/thruput/speedex.rv32a"));

    let (exchange, tokens) = run(&env, &TEST, || {
        let tokens = [
            deploy_contract(&TOKEN_A_NONCE, &token_hash),
            deploy_contract(&TOKEN_B_NONCE, &token_hash),
            deploy_contract(&TOKEN_C_NONCE, &token_hash),
        ];
        for t in &tokens {
            ERC20Client::new(t).initialize(&TEST);
        }
        let exchange = deploy_contract(&EXCHANGE_NONCE, &exchange_hash);
        let mut assets = [ContractAddress::new([0; 32]); MAX_ASSETS];
        assets[..3].copy_from_slice(&tokens);
        SpeedexClient::new(&exchange).initialize(3, assets, 1, 2, 12, 64);
        (exchange, tokens)
    });
    env.advance_block();

    let users = [(&ALICE, 0u32, 1u32), (&BOB, 1, 2), (&CAROL, 2, 0)];
    run(&env, &TEST, || {
        for (user, sell, _) in users {
            ERC20Client::new(&tokens[sell as usize]).mint(user, (1000 * UNIT) as i128);
        }
    });
    env.advance_block();

    // A ring: A for B, B for C, C for A, all in one block.
    let client = SpeedexClient::new(&exchange);
    let batch = run(&env, &TEST, || client.current_batch());
    let ids: Vec<OfferId> = users
        .iter()
        .map(|&(user, sell, buy)| {
            run(&env, user, || {
                ERC20Client::new(&tokens[sell as usize])
                    .adjust_allowance(&exchange, (1000 * UNIT) as i128);
                client.submit_offer(sell, buy, 1000 * UNIT, PRICE_ONE * 9 / 10)
            })
        })
        .collect();
    env.advance_block();

    // The cells the offers landed in, as an indexer would know them from the events.
    let grid = Grid {
        octaves: 2,
        level_bits: 12,
    };
    let level = grid.level_for(PRICE_ONE * 9 / 10).unwrap();
    let mut cells: Vec<u32> = users
        .iter()
        .map(|&(_, sell, buy)| (engine::book(sell as usize, buy as usize) as u32) << 20 | level)
        .collect();
    cells.sort_unstable();
    let cells: Vec<u8> = cells.iter().flat_map(|c| c.to_le_bytes()).collect();
    let clearing = run(&env, &TEST, || client.clear_batch(batch, &cells));
    assert!(clearing.volume > 0);
    env.advance_block();

    for id in &ids {
        run(&env, &TEST, || client.settle_offer(id));
    }
    env.advance_block();

    for (user, _, buy) in users {
        let got = run(&env, &TEST, || {
            ERC20Client::new(&tokens[buy as usize]).get_balance_of(user)
        });
        assert!(got >= (980 * UNIT) as i128, "{got}");
    }
}

/// The largest clearing the contract accepts, `max_clear_cells(n)` cells, fits the guest's memory
/// at the most assets. The guest's allocator never frees, so everything a clearing allocates (the
/// buckets, the calldata, the edges of the value graph) has to fit the declared memory, less the
/// 30 KiB stack reserve and what the runtime takes, at once; the RV32 executor enforces it.
/// `SPEEDEX_RV32_ASSETS` and `SPEEDEX_RV32_CELLS` override the counts, to find the bound again
/// when the contract or the SDK changes (with 64 KiB it lay at 192 to 208 cells with eight
/// assets, 256 to 288 with six). The mock verifies artifacts under the protocol defaults, so
/// this can only run the 64 KiB build; the devnode benchmark runs the larger one.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn largest_clearing_fits_the_guest_rv32() {
    let env = TestEnvironment::no_cost();
    let token_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/thruput/erc20.rv32a"));
    let exchange_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/thruput/speedex.rv32a"));
    let grid = Grid {
        octaves: 2,
        level_bits: 12,
    };

    let n: usize = std::env::var("SPEEDEX_RV32_ASSETS")
        .map(|v| v.parse().unwrap())
        .unwrap_or(MAX_ASSETS);
    let (exchange, tokens) = run(&env, &TEST, || {
        let tokens: Vec<ContractAddress> = (0..n as u8)
            .map(|i| {
                let nonce = SHA256Hash::from([i + 1; 32]);
                let t = deploy_contract(&nonce, &token_hash);
                ERC20Client::new(&t).initialize(&TEST);
                ERC20Client::new(&t).mint(&ALICE, i128::MAX / 4);
                t
            })
            .collect();
        let exchange = deploy_contract(&BIG_EXCHANGE_NONCE, &exchange_hash);
        let mut assets = [ContractAddress::new([0; 32]); MAX_ASSETS];
        assets[..n].copy_from_slice(&tokens);
        SpeedexClient::new(&exchange).initialize(
            n as u32,
            assets,
            1,
            grid.octaves,
            grid.level_bits,
            64,
        );
        (exchange, tokens)
    });
    env.advance_block();
    run(&env, &ALICE, || {
        for t in &tokens {
            ERC20Client::new(t).adjust_allowance(&exchange, i128::MAX / 4);
        }
    });
    env.advance_block();

    // One offer per cell, spread over every orderbook and a band of levels around one.
    let client = SpeedexClient::new(&exchange);
    let batch = run(&env, &TEST, || client.current_batch());
    let mut cells: Vec<u32> = Vec::new();
    let mut id = None;
    let cells_wanted: u32 = std::env::var("SPEEDEX_RV32_CELLS")
        .map(|v| v.parse().unwrap())
        .unwrap_or(max_clear_cells(n) as u32);
    for i in 0..cells_wanted {
        let books = (n * (n - 1)) as u32;
        let (sell, buy) = (i % books / (n as u32 - 1), i % books % (n as u32 - 1));
        let buy = if buy >= sell { buy + 1 } else { buy };
        let level = grid.levels() / 2 - 100 + i / books;
        let min_price = grid.ratio(level);
        cells.push((engine::book(sell as usize, buy as usize) as u32) << 20 | level);
        let this = run(&env, &ALICE, || {
            client.submit_offer(sell, buy, 1000 * UNIT, min_price)
        });
        id.get_or_insert(this);
    }
    env.advance_block();

    cells.sort_unstable();
    let cells: Vec<u8> = cells.iter().flat_map(|c| c.to_le_bytes()).collect();
    let clearing = run(&env, &TEST, || client.clear_batch(batch, &cells));
    assert!(clearing.volume > 0);
    env.advance_block();
    run(&env, &TEST, || client.settle_offer(&id.unwrap()));
}
