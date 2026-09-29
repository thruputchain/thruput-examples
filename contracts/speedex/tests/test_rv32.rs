//! The exchange compiled to RV32 and run by the mock executor -- the same path as on chain.
//!
//! `cargo test` runs the contract natively; this runs the artifact `groundhog build` produced, so a
//! fault in the clearing arithmetic (an overflow, a panic) is a real abort here. Run via
//! `groundhog test -p speedex`, after building `speedex` and `erc20`.

use groundhog_erc20_if::ERC20Client;
use sdk::*;
use speedex::engine::{self, Grid, PRICE_ONE};
use speedex::*;

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
#[ignore = "requires RV32 build — run via `groundhog test`"]
fn ring_trade_rv32() {
    let env = TestEnvironment::no_cost();
    let token_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/groundhog/erc20.rv32a"));
    let exchange_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/groundhog/speedex.rv32a"));

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
            ERC20Client::new(&tokens[sell as usize]).mint(user, 1000 * UNIT);
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
                ERC20Client::new(&tokens[sell as usize]).adjust_allowance(
                    &exchange,
                    (1000 * UNIT) as i128,
                    false,
                );
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
        assert!(got >= 980 * UNIT, "{got}");
    }
}

/// The largest clearing the contract accepts, `MAX_CLEAR_CELLS` cells, fits the guest's memory:
/// every bucket of the batch is held at once, along with the SDK's record of every cell read, and
/// the RV32 executor enforces the 64 KiB. `SPEEDEX_RV32_CELLS` overrides the count, to find the
/// bound when the contract or the SDK changes: with three assets it lies between 384 and 512.
#[test]
#[ignore = "requires RV32 build — run via `groundhog test`"]
fn largest_clearing_fits_the_guest_rv32() {
    let env = TestEnvironment::no_cost();
    let token_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/groundhog/erc20.rv32a"));
    let exchange_hash =
        env.setup_create_contract(&load_rv32_contract("../../target/groundhog/speedex.rv32a"));
    let grid = Grid {
        octaves: 2,
        level_bits: 12,
    };

    let (exchange, tokens) = run(&env, &TEST, || {
        let tokens = [
            deploy_contract(&TOKEN_A_NONCE, &token_hash),
            deploy_contract(&TOKEN_B_NONCE, &token_hash),
            deploy_contract(&TOKEN_C_NONCE, &token_hash),
        ];
        for t in &tokens {
            ERC20Client::new(t).initialize(&TEST);
            ERC20Client::new(t).mint(&ALICE, u128::MAX / 4);
        }
        let exchange = deploy_contract(&BIG_EXCHANGE_NONCE, &exchange_hash);
        let mut assets = [ContractAddress::new([0; 32]); MAX_ASSETS];
        assets[..3].copy_from_slice(&tokens);
        SpeedexClient::new(&exchange).initialize(3, assets, 1, grid.octaves, grid.level_bits, 64);
        (exchange, tokens)
    });
    env.advance_block();
    run(&env, &ALICE, || {
        for t in &tokens {
            ERC20Client::new(t).adjust_allowance(&exchange, i128::MAX / 4, false);
        }
    });
    env.advance_block();

    // One offer per cell, spread over the six orderbooks and a band of levels around one.
    let client = SpeedexClient::new(&exchange);
    let batch = run(&env, &TEST, || client.current_batch());
    let mut cells: Vec<u32> = Vec::new();
    let mut id = None;
    let cells_wanted: u32 = std::env::var("SPEEDEX_RV32_CELLS")
        .map(|v| v.parse().unwrap())
        .unwrap_or(MAX_CLEAR_CELLS as u32);
    for i in 0..cells_wanted {
        let (sell, buy) = [(0u32, 1u32), (1, 2), (2, 0), (1, 0), (2, 1), (0, 2)][i as usize % 6];
        let level = grid.levels() / 2 - 100 + i / 6;
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
