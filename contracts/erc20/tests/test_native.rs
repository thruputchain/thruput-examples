mod common;
use common::*;

extern crate alloc;

#[test]
fn erc20_test_native() {
    let env = sdk::TestEnvironment::no_cost();
    let test_contract = erc20::register_mock_contract(&env);

    env::test_erc20_contract(env, test_contract.as_hash());
}
