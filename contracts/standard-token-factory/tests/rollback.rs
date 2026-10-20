mod support;

use standard_token_factory::TokenCreated;
use support::*;
use thruput_erc20_if::ERC20Error;
use thruput_sdk::call::RawCallError;
use thruput_sdk::*;

fn register_failing_child(env: &TestEnvironmentHandle) -> SHA256Hash {
    *token_factory_failing_child::register_mock_contract(env).as_hash()
}

#[test]
fn failing_initializer_rolls_back_creation_fee_funding_and_events() {
    let setup = setup_with_token(FEE, Some(TREASURY), register_failing_child);
    let creation = Creation::default();
    let predicted = predict(&setup, &creation);
    adjust_allowance(&setup, FEE);
    let before = native_state(&setup, &predicted);

    let failed = fund_and_create(&setup, &creation, REQUIRED_FUNDING);
    failed.assert_abort();
    failed.assert_no_events();
    match into_root_call_result::<ContractAddress>(&failed) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<ERC20Error>(), Some(ERC20Error::Internal));
        }
        other => panic!("expected failing initializer error, got {other:?}"),
    }

    assert!(
        failed
            .filter_events::<TokenCreated>(&setup.factory)
            .is_empty()
    );
    assert_eq!(native_state(&setup, &predicted), before);

    let retried = fund_and_create(&setup, &creation, REQUIRED_FUNDING);
    retried.assert_abort();
    match into_root_call_result::<ContractAddress>(&retried) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<ERC20Error>(), Some(ERC20Error::Internal));
        }
        other => panic!("expected retry to reach the initializer, got {other:?}"),
    }
    assert_eq!(native_state(&setup, &predicted), before);
}
