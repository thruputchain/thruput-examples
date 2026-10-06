//! The SEP-41 scenarios, against the token compiled natively.

mod common;

fn token() -> common::TestToken {
    let env = sdk::TestEnvironment::no_cost();
    let contract = *sep41_token::register_mock_contract(&env).as_hash();
    common::TestToken::deploy(env, contract)
}

common::scenarios!(token);
