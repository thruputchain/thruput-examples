mod support;

use sdk::*;
use stellar_account::{
    AccountError, AccountInitError, MAX_SIGNERS, StellarAccountClient, Thresholds,
};
use stellar_account_factory_if::StellarAccountInitializerClient;
use support::*;

#[test]
fn initialize_registers_the_master_key_at_slot_zero_with_every_threshold_at_one() {
    let env = setup();
    let result = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let account = StellarAccountClient::new(&ACCOUNT);
            (
                account.master_key(),
                account.thresholds(),
                account.signer_weights(),
            )
        })
    });
    result.assert_success();
    let (key, thresholds, weights): (Ed25519PublicKey, Thresholds, [u32; MAX_SIGNERS]) =
        result.assert_return_as();
    assert_eq!(key, master_key());
    assert_eq!(
        thresholds,
        Thresholds {
            low: 1,
            medium: 1,
            high: 1
        }
    );
    let mut expected = [0u32; MAX_SIGNERS];
    expected[0] = 1;
    assert_eq!(weights, expected);
}

#[test]
fn initialize_refuses_a_second_call() {
    let env = setup();
    env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let result =
                StellarAccountInitializerClient::new(&ACCOUNT).try_initialize(&second_key());
            assert_eq!(
                result.unwrap_err().try_as(),
                Some(AccountInitError::AlreadyInitialized)
            );
        })
    })
    .assert_success();
}

#[test]
fn payment_at_the_medium_threshold_moves_tokens() {
    let env = setup();
    as_account(
        &env,
        claim(1),
        &(TOKEN, RECEIVER, 250u128),
        stellar_account::stellar_account_exports::payment_internal,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(balance_of(&env, RECEIVER), 250);
    assert_eq!(balance_of(&env, ACCOUNT), MINTED - 250);
}

#[test]
#[ignore = "set_thresholds lands in Task 4"]
fn payment_below_the_medium_threshold_is_refused() {
    let env = setup();
    raise_thresholds(&env, 1, 2, 2);
    let result = as_account(
        &env,
        claim(1),
        &(TOKEN, RECEIVER, 250u128),
        stellar_account::stellar_account_exports::payment_internal,
    );
    assert_account_error(&result, AccountError::InsufficientAuthWeight);
    env.advance_block();
    assert_eq!(balance_of(&env, RECEIVER), 0);
}

#[test]
fn a_pubkey_claim_carries_no_weight() {
    let env = setup();
    let result = as_account(
        &env,
        pubkey_claim(),
        &(TOKEN, RECEIVER, 1u128),
        stellar_account::stellar_account_exports::payment_internal,
    );
    assert_account_error(&result, AccountError::InsufficientAuthWeight);
}

#[test]
fn a_call_from_another_contract_is_not_the_root_invocation() {
    let env = setup();
    // A strong claim, but on ROOT's transaction, not the account's.
    env.transaction()
        .with_auth_claim(claim(100))
        .transact(|tx| {
            tx.call(&ROOT).run(|| {
                let result = StellarAccountClient::new(&ACCOUNT).try_payment(&TOKEN, &RECEIVER, 1);
                assert_eq!(
                    result.unwrap_err().try_as(),
                    Some(AccountError::NotRootInvocation)
                );
            })
        })
        .assert_success();
}

#[test]
fn payment_beyond_the_balance_surfaces_the_token_error() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(TOKEN, RECEIVER, MINTED + 1),
        stellar_account::stellar_account_exports::payment_internal,
    );
    result.assert_abort();
    match into_root_call_result::<()>(&result) {
        Err(sdk::call::RawCallError::Exception(error)) => {
            assert!(
                error.try_as::<erc20::ERC20Error>().is_some(),
                "an ERC20 error, got {error:?}"
            );
        }
        other => panic!("expected an ERC20 exception, got {other:?}"),
    }
}

/// Raise thresholds as the account at a claimed weight that clears the
/// current high threshold (1 right after setup).
fn raise_thresholds(_env: &TestEnvironmentHandle, _low: u32, _medium: u32, _high: u32) {
    unimplemented!("Task 4")
}
