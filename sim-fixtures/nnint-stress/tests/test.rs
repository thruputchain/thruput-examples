use nnint_stress::*;
use sdk::*;

static NNINT_STRESS_NONCE: SHA256Hash = sdk::sha256_static!("NNINT_STRESS_TEST_NONCE");

fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = nnint_stress::register_mock_contract(&env);
    (env, *contract.as_hash())
}

#[test]
fn churn_updates_global_and_per_caller_nnints() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NNINT_STRESS_NONCE, &contract_hash);
            let client = NnintStressClient::new(&addr);

            assert_eq!(client.churn(10, 3), 8);
            assert_eq!(client.churn(5, 1), 13);
            assert_eq!(client.total(), 13);
            assert_eq!(client.caller_total(), 13);
        })
    });

    result.assert_success();
}

#[test]
fn churn_caps_refund_to_keep_nnint_non_negative() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&NNINT_STRESS_NONCE, &contract_hash);
            let client = NnintStressClient::new(&addr);

            assert_eq!(client.churn(4, 99), 1);
            assert_eq!(client.total(), 1);
            assert_eq!(client.caller_total(), 1);
        })
    });

    result.assert_success();
}
