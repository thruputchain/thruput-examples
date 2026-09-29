//! The exchange compiled to RV32 and run by the mock executor -- the same path as on chain.
//!
//! `cargo test` runs the contract natively; this runs the artifact `groundhog build` produced, so a
//! fault in the clearing arithmetic (an overflow, a panic) is a real abort here. Run via
//! `groundhog test -p speedex`, after building `speedex` and `erc20`.

use groundhog_erc20_if::ERC20Client;
use sdk::*;
use speedex::engine::PRICE_ONE;
use speedex::*;

hash_ident! { static TEST: ContractAddress; }
hash_ident! { static ALICE: ContractAddress; }
hash_ident! { static BOB: ContractAddress; }
hash_ident! { static CAROL: ContractAddress; }
hash_ident! { static TOKEN_A_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_B_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_C_NONCE: SHA256Hash; }
hash_ident! { static EXCHANGE_NONCE: SHA256Hash; }

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
        SpeedexClient::new(&exchange).initialize(&TEST, 3, assets, 1, 2);
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
                ERC20Client::new(&tokens[sell as usize])
                    .adjust_allowance(&exchange, (1000 * UNIT) as i128);
                client.submit_offer(sell, buy, 1000 * UNIT, PRICE_ONE * 9 / 10)
            })
        })
        .collect();
    env.advance_block();

    let clearing = run(&env, &TEST, || client.clear_batch(batch));
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
