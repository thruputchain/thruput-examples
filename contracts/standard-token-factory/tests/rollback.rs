mod support;

use groundhog_erc20_if::ERC20Error;
use sdk::call::RawCallError;
use sdk::*;
use standard_token_factory::{TokenCreated, TokenFactoryError};
use support::*;
use token_factory_test_if::TokenFactoryFailingChildClient;

fn assert_initializer_failure(result: &TransactResult) {
    result.assert_abort();
    result.assert_no_events();
    match into_root_call_result::<ContractAddress>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<ERC20Error>(), Some(ERC20Error::Internal));
        }
        other => panic!("expected failing initializer error, got {other:?}"),
    }
}

fn assert_child_absent(setup: &Setup, predicted: &ContractAddress) {
    let predicted = *predicted;
    let probe = setup.env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| TokenFactoryFailingChildClient::new(&predicted).value())
    });
    probe.assert_abort();
    probe.assert_no_events();
}

#[test]
fn repeated_failing_initializations_leave_no_effects_and_preserve_retry_funding() {
    let setup = setup(FEE, Some(TREASURY), ChildArtifact::Failing);
    let creation = Creation::default();
    let predicted = predict(&setup, &creation);
    fund(&setup, &predicted, REQUIRED_FUNDING);
    adjust_allowance(&setup, FEE as i128);
    let before = native_state(&setup, &predicted);

    for _ in 0..2 {
        let failed = create(&setup, &creation);
        assert_initializer_failure(&failed);
        assert_eq!(
            failed.filter_events::<TokenCreated>(&setup.factory).len(),
            0
        );
        assert_eq!(native_state(&setup, &predicted), before);
        assert_child_absent(&setup, &predicted);
    }

    assert_eq!(before.predicted, REQUIRED_FUNDING);
    assert_eq!(before.allowance, FEE);
    assert_eq!(before.factory, 0);
}

#[test]
fn failed_atomic_wallet_creation_restores_prediction_funding_and_fee_state() {
    let setup = setup(FEE, Some(TREASURY), ChildArtifact::Failing);
    let creation = Creation::default();
    let predicted = predict(&setup, &creation);
    adjust_allowance(&setup, FEE as i128);
    let before = native_state(&setup, &predicted);
    assert_eq!(before.predicted, 0);

    let failed = fund_and_create(&setup, &creation, REQUIRED_FUNDING);
    assert_initializer_failure(&failed);
    assert_eq!(native_state(&setup, &predicted), before);
    assert_child_absent(&setup, &predicted);
}

#[test]
fn unavailable_artifact_propagates_runtime_failure_and_rolls_back_fee() {
    let setup = setup(FEE, Some(TREASURY), ChildArtifact::Unavailable);
    let creation = Creation::default();
    let predicted = predict(&setup, &creation);
    fund(&setup, &predicted, REQUIRED_FUNDING);
    adjust_allowance(&setup, FEE as i128);
    let before = native_state(&setup, &predicted);

    let failed = create(&setup, &creation);
    failed.assert_abort();
    failed.assert_no_events();
    match into_root_call_result::<ContractAddress>(&failed) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<TokenFactoryError>(), None);
            let library = error
                .try_as::<sdk::exn::LibraryExn>()
                .expect("deployment failure remains an SDK library exception");
            let syscall = library
                .as_syscall_exn()
                .expect("deployment failure remains a syscall exception");
            assert!(syscall.is(
                10.into(),
                sdk::sys::SyscallErrorCode::kSyscallErrorCodeInvalidSyscallInput,
            ));
        }
        Err(other) => panic!("expected deployment fault, got {other:?}"),
        Ok(address) => panic!("unavailable artifact unexpectedly deployed at {address:?}"),
    }
    assert_eq!(native_state(&setup, &predicted), before);
}
