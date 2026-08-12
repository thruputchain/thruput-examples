mod support;

use groundhog_erc20_if::{ERC20Client, ERC20Error};
use sdk::call::RawCallError;
use sdk::*;
use standard_token_factory::Amount;
use support::*;
use token_factory_test_if::TokenFactoryTestWalletClient;

const RECEIVER: ContractAddress = ContractAddress::new([0x81; 32]);
const SPENDER: ContractAddress = ContractAddress::new([0x82; 32]);

fn assert_erc20_error(result: &TransactResult, expected: ERC20Error) {
    result.assert_abort();
    result.assert_no_events();
    match into_root_call_result::<()>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<ERC20Error>(), Some(expected));
        }
        other => panic!("expected ERC20 error {expected:?}, got {other:?}"),
    }
}

fn token_and_native_state(
    setup: &Setup,
    token: ContractAddress,
) -> (Amount, Amount, Amount, Amount, Amount) {
    let native = setup.native_token;
    let wallet = setup.wallet;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            (
                ERC20Client::new(&native).get_balance_of(&wallet),
                ERC20Client::new(&native).get_balance_of(&token),
                ERC20Client::new(&token).get_balance_of(&wallet),
                ERC20Client::new(&token).get_balance_of(&RECEIVER),
                ERC20Client::new(&token).allowance(&wallet, &SPENDER),
            )
        })
    });
    result.assert_success();
    result.assert_return_as()
}

#[test]
fn mock_top_up_and_token_operations_commit_or_roll_back_atomically() {
    let setup = setup(0, None, ChildArtifact::Standard);
    let creation = Creation {
        initial_holder: setup.wallet,
        initial_supply: 1_000,
        ..Creation::default()
    };
    let token = predict(&setup, &creation);
    fund(&setup, &token, REQUIRED_FUNDING);
    create(&setup, &creation).assert_success();
    setup.env.advance_block();

    let wallet = setup.wallet;
    let native = setup.native_token;
    let transferred = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet)
                .top_up_and_transfer(&native, &token, &RECEIVER, 12, 100)
        })
    });
    transferred.assert_success();
    setup.env.advance_block();
    let after_transfer = token_and_native_state(&setup, token);
    assert_eq!(after_transfer.1, REQUIRED_FUNDING + 12);
    assert_eq!(after_transfer.2, 900);
    assert_eq!(after_transfer.3, 100);

    let failed_transfer = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet)
                .top_up_and_transfer(&native, &token, &RECEIVER, 7, 10_000)
        })
    });
    assert_erc20_error(&failed_transfer, ERC20Error::TooLarge);
    assert_eq!(token_and_native_state(&setup, token), after_transfer);

    let adjusted = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet)
                .top_up_and_adjust_allowance(&native, &token, &SPENDER, 9, 100)
        })
    });
    adjusted.assert_success();
    setup.env.advance_block();
    let after_allowance = token_and_native_state(&setup, token);
    assert_eq!(after_allowance.1, REQUIRED_FUNDING + 21);
    assert_eq!(after_allowance.4, 100);

    let failed_allowance = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet)
                .top_up_and_adjust_allowance(&native, &token, &SPENDER, 11, -101)
        })
    });
    assert_erc20_error(&failed_allowance, ERC20Error::TooLarge);
    assert_eq!(token_and_native_state(&setup, token), after_allowance);
}
