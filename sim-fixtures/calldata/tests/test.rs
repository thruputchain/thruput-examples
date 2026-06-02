use calldata::*;
use sdk::*;

static CALLDATA_NONCE: SHA256Hash = sdk::sha256_static!("CALLDATA_TEST_NONCE");

fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = calldata::register_mock_contract(&env);
    (env, *contract.as_hash())
}

#[test]
fn sum16_returns_sum() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CALLDATA_NONCE, &contract_hash);
            let client = CalldataClient::new(&addr);
            assert_eq!(
                client.sum16(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,),
                136,
            );
        })
    });

    result.assert_success();
}
