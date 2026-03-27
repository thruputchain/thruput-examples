use multi_impl::*;
use multi_impl_traits::*;
use sdk::*;

static CONTRACT_NONCE: SHA256Hash = sdk::sha256_static!("MULTI_IMPL");

/// Helper: register both trait implementations on a single contract.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = {
        let mut c = env.add_contract();
        c.register(<MathContract as Adder>::__mock)
            .register(<MathContract as Multiplier>::__mock);
        c.as_contract()
    };
    let contract_hash = env.setup_create_contract(&contract);
    (env, contract_hash)
}

#[test]
fn test_add() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let mut client = AdderClient::new(&addr);

            assert_eq!(client.add(2, 3), 5);
            assert_eq!(client.add(0, 0), 0);
            assert_eq!(client.add(100, 200), 300);
        })
    });
    result.assert_success();
}

#[test]
fn test_add_overflow() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let mut client = AdderClient::new(&addr);

            // Adding u64::MAX + 1 should throw AdderError::Overflow
            match client.try_add(u64::MAX, 1) {
                Err(AdderClientError::AdderError(AdderError::Overflow)) => {}
                other => panic!("Expected AdderError::Overflow, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

#[test]
fn test_multiply() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let mut client = MultiplierClient::new(&addr);

            assert_eq!(client.multiply(3, 4), 12);
            assert_eq!(client.multiply(0, 100), 0);
            assert_eq!(client.multiply(7, 7), 49);
        })
    });
    result.assert_success();
}

#[test]
fn test_square() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let mut client = MultiplierClient::new(&addr);

            assert_eq!(client.square(5), 25);
            assert_eq!(client.square(0), 0);
            assert_eq!(client.square(10), 100);
        })
    });
    result.assert_success();
}

#[test]
fn test_multiply_overflow() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let mut client = MultiplierClient::new(&addr);

            // Multiplying u64::MAX * 2 should throw MultiplierError::Overflow
            match client.try_multiply(u64::MAX, 2) {
                Err(MultiplierClientError::MultiplierError(MultiplierError::Overflow)) => {}
                other => panic!("Expected MultiplierError::Overflow, got: {:?}", other),
            }
        })
    });
    result.assert_success();
}

/// Demonstrates both traits working on the same deployed contract.
#[test]
fn test_both_traits_same_contract() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);

            // Both clients point to the same contract address
            let mut adder = AdderClient::new(&addr);
            let mut multiplier = MultiplierClient::new(&addr);

            let sum = adder.add(3, 4);
            assert_eq!(sum, 7);

            let product = multiplier.multiply(3, 4);
            assert_eq!(product, 12);

            let squared = multiplier.square(sum);
            assert_eq!(squared, 49);
        })
    });
    result.assert_success();
}
