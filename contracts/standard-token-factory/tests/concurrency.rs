mod support;

use groundhog_erc20_if::{AllowanceChangeEvent, ERC20Error, MintEvent, TransferEvent};
use sdk::call::RawCallError;
use sdk::*;
use standard_token_factory::{
    FactoryConfig, StandardTokenFactoryClient, TokenCreated, TokenFactoryError,
};
use support::*;

fn assert_erc20_error(result: &TransactResult, expected: ERC20Error) {
    result.assert_abort();
    result.assert_no_events();
    match into_root_call_result::<ContractAddress>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<ERC20Error>(), Some(expected));
        }
        other => panic!("expected ERC20 error {expected:?}, got {other:?}"),
    }
}

fn assert_fee_events(result: &TransactResult, setup: &Setup) {
    // Spending the fee allowance is recorded by the transfer alone.
    let changes = result.filter_events::<AllowanceChangeEvent<'_>>(&setup.native_token);
    let transfers = result.filter_events::<TransferEvent<'_>>(&setup.native_token);
    assert!(changes.is_empty());
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0].topic(1).unwrap(), setup.wallet.as_ref());
    assert_eq!(transfers[0].topic(2).unwrap(), TREASURY.as_ref());
    assert_eq!(transfers[0].payload().amount, FEE);
}

#[test]
fn fee_configuration_rejects_missing_or_zero_treasury() {
    let env = TestEnvironment::no_cost();
    let factory_hash = *standard_token_factory::register_mock_contract(&env).as_hash();
    let token_hash = SHA256Hash::new([0xa1; 32]);
    let native_token = ContractAddress::new([0xa2; 32]);

    for index in 0..4 {
        let nonce = SHA256Hash::new([0xa3 + index as u8; 32]);
        let deployed = env.transact(|tx| {
            tx.call(&ROOT)
                .run(|| deploy_contract(&nonce, &factory_hash))
        });
        deployed.assert_success();
        let factory = deployed.assert_return_as();
        env.advance_block();
        let (fee, recipient) = match index {
            0 => (FEE, None),
            1 => (FEE, Some(*groundhog_erc20_if::CONTRACT_ADDR_ZERO)),
            2 => (FEE, Some(factory)),
            3 => (-1, Some(TREASURY)),
            _ => unreachable!(),
        };

        let rejected = env.transact(|tx| {
            tx.call(&ROOT).run(|| {
                StandardTokenFactoryClient::new(&factory).initialize(FactoryConfig {
                    token_code_hash: token_hash,
                    required_token_funding: REQUIRED_FUNDING,
                    native_token,
                    creation_fee: fee,
                    fee_recipient: recipient,
                })
            })
        });
        rejected.assert_abort();
        match into_root_call_result::<()>(&rejected) {
            Err(RawCallError::Exception(error)) => assert_eq!(
                error.try_as::<TokenFactoryError>(),
                Some(TokenFactoryError::InvalidConfig)
            ),
            other => panic!("expected InvalidConfig, got {other:?}"),
        }
    }

    let deployed = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| deploy_contract(&SHA256Hash::new([0xaf; 32]), &factory_hash))
    });
    deployed.assert_success();
    let factory = deployed.assert_return_as();
    env.advance_block();
    let maximum = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            StandardTokenFactoryClient::new(&factory).initialize(FactoryConfig {
                token_code_hash: token_hash,
                required_token_funding: REQUIRED_FUNDING,
                native_token,
                creation_fee: i128::MAX,
                fee_recipient: Some(TREASURY),
            })
        })
    });
    maximum.assert_success();
}

#[test]
fn optional_fee_matrix_preserves_balances_allowance_and_direct_payment() {
    for allowance in [FEE, FEE * 2] {
        let setup = setup(FEE, Some(TREASURY));
        let creation = Creation {
            initial_supply: 0,
            ..Creation::default()
        };
        let predicted = predict(&setup, &creation);
        fund(&setup, &predicted, REQUIRED_FUNDING);
        adjust_allowance(&setup, allowance);
        let before = native_state(&setup, &predicted);

        let result = create(&setup, &creation);
        result.assert_success();
        assert_eq!(result.assert_return_as::<ContractAddress>(), predicted);
        assert_fee_events(&result, &setup);
        assert_eq!(
            result.filter_events::<TokenCreated>(&setup.factory).len(),
            1
        );
        setup.env.advance_block();

        let after = native_state(&setup, &predicted);
        assert_eq!(after.wallet, before.wallet - FEE);
        assert_eq!(after.predicted, before.predicted);
        assert_eq!(after.treasury, before.treasury + FEE);
        assert_eq!(after.factory, 0);
        assert_eq!(after.allowance, allowance - FEE);
    }

    let fee_setup = setup(FEE, Some(TREASURY));
    let creation = Creation {
        initial_supply: 0,
        ..Creation::default()
    };
    let predicted = predict(&fee_setup, &creation);
    fund(&fee_setup, &predicted, REQUIRED_FUNDING);
    adjust_allowance(&fee_setup, FEE - 1);
    let before = native_state(&fee_setup, &predicted);

    let rejected = create(&fee_setup, &creation);
    assert_erc20_error(&rejected, ERC20Error::TooLarge);
    assert_eq!(native_state(&fee_setup, &predicted), before);

    adjust_allowance(&fee_setup, 1);
    let retried = create(&fee_setup, &creation);
    retried.assert_success();
    assert_fee_events(&retried, &fee_setup);
    fee_setup.env.advance_block();
    let after = native_state(&fee_setup, &predicted);
    assert_eq!(after.wallet, before.wallet - FEE);
    assert_eq!(after.treasury, before.treasury + FEE);
    assert_eq!(after.allowance, 0);

    let free = setup(0, None);
    let creation = Creation {
        initial_supply: 0,
        ..Creation::default()
    };
    let predicted = predict(&free, &creation);
    fund(&free, &predicted, REQUIRED_FUNDING);
    let before = native_state(&free, &predicted);
    let result = create(&free, &creation);
    result.assert_success();
    assert!(result.events_from(&free.native_token).is_empty());
    free.env.advance_block();
    assert_eq!(native_state(&free, &predicted), before);
}

#[test]
fn duplicate_same_block_creation_commits_once() {
    let setup = setup(FEE, Some(TREASURY));
    let creation = Creation::default();
    let predicted = predict(&setup, &creation);
    fund(&setup, &predicted, REQUIRED_FUNDING);
    adjust_allowance(&setup, FEE * 2);

    let factory = setup.factory;
    let wallet = setup.wallet;
    let create = || {
        StandardTokenFactoryClient::new(&factory).create_token(
            &creation.nonce,
            &creation.administrator,
            creation.name.clone(),
            creation.symbol.clone(),
            creation.decimals,
            &creation.initial_holder,
            creation.initial_supply,
        )
    };
    let mut first = setup.env.transaction().build();
    let mut duplicate = setup.env.transaction().build();
    let committed = first.call(&wallet).run(create);
    let conflicted = duplicate.call(&wallet).run(create);
    committed.assert_success();
    conflicted.assert_success();

    assert_eq!(first.try_commit_transaction(), TryCommitResult::Ok);
    assert!(matches!(
        duplicate.try_commit_transaction(),
        TryCommitResult::TxNonDeterministicError(_)
    ));
    assert_eq!(committed.filter_events::<TokenCreated>(&factory).len(), 1);
    assert_eq!(
        committed.filter_events::<MintEvent<'_>>(&predicted).len(),
        1
    );
    let changes = committed.filter_events::<AllowanceChangeEvent<'_>>(&setup.native_token);
    let transfers = committed.filter_events::<TransferEvent<'_>>(&setup.native_token);
    assert!(changes.is_empty());
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0].topic(2).unwrap(), TREASURY.as_ref());
    assert_eq!(transfers[0].payload().amount, FEE);
    drop(first);
    drop(duplicate);
    setup.env.advance_block();

    let state = native_state(&setup, &predicted);
    assert_eq!(state.treasury, FEE);
    assert_eq!(state.allowance, FEE);
}
