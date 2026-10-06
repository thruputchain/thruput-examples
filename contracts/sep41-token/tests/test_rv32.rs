//! The SEP-41 scenarios, against the token compiled to RV32.
//!
//! Unlike `cargo test` (which runs natively with unwind), the contract here
//! is compiled to RV32 and executed by the mock executor — the same path as
//! on-chain. Use `groundhog test` to build the artifact and run these.

mod common;

fn token() -> common::TestToken {
    let contract = sdk::load_rv32_contract("../../target/groundhog/sep41_token.rv32a");
    let env = sdk::TestEnvironment::no_cost();
    let contract = env.setup_create_contract(&contract);
    common::TestToken::deploy(env, contract)
}

common::scenarios!(
    #[ignore = "requires RV32 build — run via `groundhog test`"]
    token
);
