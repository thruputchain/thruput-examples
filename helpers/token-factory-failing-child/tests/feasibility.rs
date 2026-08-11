use sdk::call::RawCallError;
use sdk::*;
use token_factory_failing_child::register_mock_contract;
use token_factory_test_if::{TokenFactoryFailingChildClient, TokenFactoryFixtureError};

const DEPLOYER: ContractAddress = ContractAddress::new([0x10; 32]);
const ROOT_A: ContractAddress = ContractAddress::new([0x20; 32]);
const ROOT_B: ContractAddress = ContractAddress::new([0x30; 32]);
const NONCE: SHA256Hash = SHA256Hash::new([0x40; 32]);

fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let child_hash = *register_mock_contract(&env).as_hash();
    (env, child_hash)
}

fn deploy(env: &TestEnvironmentHandle, child_hash: &SHA256Hash) -> ContractAddress {
    let result = env.transact(|tx| {
        tx.call(&DEPLOYER)
            .run(|| deploy_contract(&NONCE, child_hash))
    });
    result.assert_success();
    result.assert_return_as()
}

#[test]
fn registered_child_is_callable_in_deployment_transaction() {
    let (env, child_hash) = setup();
    let result = env.transact(|tx| {
        tx.call(&DEPLOYER).run(|| {
            let child = deploy_contract(&NONCE, &child_hash);
            let observed = TokenFactoryFailingChildClient::new(&child).caller();
            (child, observed)
        })
    });

    result.assert_success();
    result.assert_return_with::<(ContractAddress, ContractAddress)>(|(_, observed)| {
        assert_eq!(*observed, DEPLOYER);
    });
}

#[test]
fn failed_initializer_rolls_back_deployment_and_retry_reaches_initializer() {
    let (env, child_hash) = setup();

    for _ in 0..2 {
        let result = env.transact(|tx| {
            tx.call(&DEPLOYER).run(|| {
                let child = deploy_contract(&NONCE, &child_hash);
                TokenFactoryFailingChildClient::new(&child).initialize_failing();
            })
        });
        result.assert_abort();
        result.assert_event_count(0);
        match into_root_call_result::<()>(&result) {
            Err(RawCallError::Exception(error)) => assert_eq!(
                error.try_as::<TokenFactoryFixtureError>(),
                Some(TokenFactoryFixtureError::DeliberateFailure)
            ),
            other => panic!("expected deliberate initializer failure, got {other:?}"),
        }
    }
}

#[test]
fn identical_same_block_deployments_can_both_commit() {
    let (env, child_hash) = setup();
    let mut tx_a = env.transaction().build();
    let mut tx_b = env.transaction().build();

    tx_a.call(&DEPLOYER)
        .run(|| deploy_contract(&NONCE, &child_hash))
        .assert_success();
    tx_b.call(&DEPLOYER)
        .run(|| deploy_contract(&NONCE, &child_hash))
        .assert_success();

    assert_eq!(tx_a.try_commit_transaction(), TryCommitResult::Ok);
    assert_eq!(tx_b.try_commit_transaction(), TryCommitResult::Ok);
}

#[test]
fn same_block_exclusive_writes_allow_exactly_one_commit() {
    let (env, child_hash) = setup();
    let child = deploy(&env, &child_hash);
    env.advance_block();

    let mut tx_a = env.transaction().build();
    let mut tx_b = env.transaction().build();
    let frame_a = tx_a
        .call(&ROOT_A)
        .run(|| TokenFactoryFailingChildClient::new(&child).write_exclusive(1));
    let frame_b = tx_b
        .call(&ROOT_B)
        .run(|| TokenFactoryFailingChildClient::new(&child).write_exclusive(1));
    frame_a.assert_event_count(1);
    frame_b.assert_event_count(1);

    assert_eq!(tx_a.try_commit_transaction(), TryCommitResult::Ok);
    assert!(matches!(
        tx_b.try_commit_transaction(),
        TryCommitResult::TxNonDeterministicError(_)
    ));

    drop(tx_a);
    drop(tx_b);
    env.advance_block();
    let stored = env.transact(|tx| {
        tx.call(&ROOT_A)
            .run(|| TokenFactoryFailingChildClient::new(&child).value())
    });
    stored.assert_success();
    assert_eq!(stored.assert_return_as::<Option<u64>>(), Some(1));
}
