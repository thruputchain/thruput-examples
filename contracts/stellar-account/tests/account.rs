mod support;

use sdk::*;
use stellar_account::{
    AccountError, AccountInitError, MAX_SIGNERS, SignerChanged, StellarAccountClient, Thresholds,
    ThresholdsChanged,
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
fn payment_below_the_medium_threshold_is_refused() {
    let env = setup();
    // Add a second signer so total weight = 2, allowing high=2 without lockout.
    add_second_signer(&env, 1).assert_success();
    env.advance_block();
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

fn weights(env: &TestEnvironmentHandle) -> [u32; MAX_SIGNERS] {
    let result = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| StellarAccountClient::new(&ACCOUNT).signer_weights())
    });
    result.assert_success();
    result.assert_return_as()
}

fn add_second_signer(env: &TestEnvironmentHandle, weight: u32) -> TransactResult {
    as_account(
        env,
        claim(1),
        &(1u32, second_key(), weight),
        stellar_account::stellar_account_exports::set_signer_internal,
    )
}

/// Raise thresholds as the account at a claimed weight that clears the
/// current high threshold (1 right after setup).
fn raise_thresholds(env: &TestEnvironmentHandle, low: u32, medium: u32, high: u32) {
    as_account(
        env,
        claim(1),
        &(low, medium, high),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    )
    .assert_success();
    env.advance_block();
}

#[test]
fn set_signer_needs_the_high_threshold_and_updates_the_mirror_and_event() {
    let env = setup();
    // Add a second signer first so total weight = 2 before raising high to 2.
    add_second_signer(&env, 1).assert_success();
    env.advance_block();
    raise_thresholds(&env, 1, 1, 2);
    // Now high is 2 and total weight is 2: a claim of 1 is refused.
    let refused = add_second_signer(&env, 1);
    assert_account_error(&refused, AccountError::InsufficientAuthWeight);

    // Claiming 2 passes the account check. (On chain this would need two
    // signers; the mock does not verify signatures.)
    let result = as_account(
        &env,
        claim(2),
        &(1u32, second_key(), 3u32),
        stellar_account::stellar_account_exports::set_signer_internal,
    );
    result.assert_success();
    result.assert_event_count(1);
    result.assert_event::<SignerChanged>(0, |e| {
        assert_eq!(e.payload().weight, 3);
    });
    env.advance_block();
    let w = weights(&env);
    assert_eq!(w[0], 1);
    assert_eq!(w[1], 3);
}

#[test]
fn set_signer_rejects_slot_zero_out_of_range_slots_and_zero_weight() {
    let env = setup();
    for (slot, weight, expected) in [
        (0u32, 1u32, AccountError::InvalidSlot),
        (MAX_SIGNERS as u32, 1, AccountError::InvalidSlot),
        (1, 0, AccountError::ZeroWeight),
    ] {
        let result = as_account(
            &env,
            claim(1),
            &(slot, second_key(), weight),
            stellar_account::stellar_account_exports::set_signer_internal,
        );
        assert_account_error(&result, expected);
    }
}

#[test]
fn remove_signer_rejects_slot_zero_and_empty_slots() {
    let env = setup();
    for slot in [0u32, 5] {
        let result = as_account(
            &env,
            claim(1),
            &slot,
            stellar_account::stellar_account_exports::remove_signer_internal,
        );
        assert_account_error(&result, AccountError::InvalidSlot);
    }
}

#[test]
fn remove_signer_clears_the_slot_and_emits_weight_zero() {
    let env = setup();
    add_second_signer(&env, 2).assert_success();
    env.advance_block();
    let result = as_account(
        &env,
        claim(1),
        &1u32,
        stellar_account::stellar_account_exports::remove_signer_internal,
    );
    result.assert_success();
    result.assert_event::<SignerChanged>(0, |e| assert_eq!(e.payload().weight, 0));
    env.advance_block();
    assert_eq!(weights(&env)[1], 0);
}

#[test]
fn set_thresholds_pins_low_as_the_chain_threshold_and_emits() {
    let env = setup();
    add_second_signer(&env, 2).assert_success();
    env.advance_block();
    let result = as_account(
        &env,
        claim(1),
        &(1u32, 2u32, 3u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    result.assert_success();
    result.assert_event::<ThresholdsChanged>(0, |e| {
        assert_eq!(
            (e.payload().low, e.payload().medium, e.payload().high),
            (1, 2, 3)
        );
    });
    env.advance_block();
    let t = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| StellarAccountClient::new(&ACCOUNT).thresholds())
    });
    t.assert_success();
    assert_eq!(
        t.assert_return_as::<Thresholds>(),
        Thresholds {
            low: 1,
            medium: 2,
            high: 3
        }
    );
}

#[test]
fn changes_that_would_lock_the_account_out_are_refused_and_write_nothing() {
    let env = setup();
    // Total weight is 1; a high threshold of 2 is unreachable.
    let result = as_account(
        &env,
        claim(1),
        &(1u32, 1u32, 2u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    result.assert_no_events();

    // A zero threshold is never allowed: it would admit an unsigned transaction.
    let result = as_account(
        &env,
        claim(1),
        &(0u32, 1u32, 1u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);

    // Removing the only signer that carries the high threshold.
    let result = as_account(
        &env,
        claim(1),
        &0u32,
        stellar_account::stellar_account_exports::set_master_weight_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    env.advance_block();
    assert_eq!(weights(&env)[0], 1, "nothing was written");
}

#[test]
fn master_weight_zero_disables_slot_zero_but_the_master_key_is_unchanged() {
    let env = setup();
    add_second_signer(&env, 1).assert_success();
    env.advance_block();

    as_account(
        &env,
        claim(1),
        &0u32,
        stellar_account::stellar_account_exports::set_master_weight_internal,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(weights(&env)[0], 0);
    let key = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| StellarAccountClient::new(&ACCOUNT).master_key())
    });
    key.assert_success();
    assert_eq!(
        key.assert_return_as::<Ed25519PublicKey>(),
        master_key(),
        "identity is fixed"
    );

    // Re-enabling re-registers the stored creation key with the new weight.
    as_account(
        &env,
        claim(1),
        &4u32,
        stellar_account::stellar_account_exports::set_master_weight_internal,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(weights(&env)[0], 4);
}
