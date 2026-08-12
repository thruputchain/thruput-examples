mod common;
use common::*;

extern crate alloc;

/// Test the contract running as RV32 in the executor.
///
/// Unlike `cargo test` (which runs natively with unwind),
/// the contract here is compiled to RV32 and executed by
/// the mock executor — the same path as on-chain. A
/// contract fault (e.g. NNInt underflow) is a real abort,
/// not a caught Rust panic.
///
/// Use `cargo test` for fast iteration and error-path
/// testing. Use `groundhog test` to verify the contract
/// behaves correctly under real execution semantics.
#[test]
#[ignore = "requires RV32 build — run via `groundhog test`"]
fn erc20_test_rv32() {
    let contract = sdk::load_rv32_contract("../../target/groundhog/erc20.rv32a");
    let env = sdk::TestEnvironment::no_cost();
    let contract_hash = env.setup_create_contract(&contract);

    env::test_erc20_contract(env, &contract_hash);
}
