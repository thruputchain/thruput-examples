mod support;

use sdk::*;
use stellar_account::{
    AccountError, AccountInitError, MAX_SIGNERS, SignerChanged, StellarAccountClient, Thresholds,
    ThresholdsChanged,
};
use stellar_account_factory_if::StellarAccountInitializerClient;
use support::*;

/// The ERC20 `transfer` entrypoint ID.
///
/// `ERC20Entrypoints` is not generated for a trait impl (only for inherent
/// impls). Computed here with the same formula as the `#[contract]` macro:
/// sha256(INTERFACE_NAME ++ "::" ++ MAJOR_VERSION ++ "::" ++ METHOD_NAME)[0..8].
/// For groundhog-erc20-if 0.1.42: interface = "ERC20", major = "0.1",
/// method = "transfer".  The `sdk::hash_to_array!` proc-macro hashes
/// "ERC20::0.1::transfer" with sha256 at compile time.
fn erc20_transfer_entrypoint() -> ContractEntrypointID {
    let h: [u8; 32] = sdk::hash_to_array!("ERC20::0.1::transfer");
    ContractEntrypointID::from([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]])
}

#[test]
fn invoke_forwards_opaque_calldata_and_returns_the_child_bytes() {
    let env = setup();
    let calldata = sdk::xdr::cxs::encode(&(RECEIVER, 100u128)).unwrap();
    let result = as_account(
        &env,
        claim(1),
        &(
            TOKEN,
            erc20_transfer_entrypoint(),
            u64::MAX,
            calldata.as_slice(),
        ),
        stellar_account::stellar_account_exports::invoke_internal,
    );
    result.assert_success();
    assert!(
        result.assert_return_as::<BytesM>().is_empty(),
        "transfer returns unit"
    );
    env.advance_block();
    assert_eq!(balance_of(&env, RECEIVER), 100);
}

#[test]
fn invoke_re_raises_the_child_abort_verbatim() {
    let env = setup();
    let calldata = sdk::xdr::cxs::encode(&(RECEIVER, MINTED + 1)).unwrap();
    let result = as_account(
        &env,
        claim(1),
        &(
            TOKEN,
            erc20_transfer_entrypoint(),
            u64::MAX,
            calldata.as_slice(),
        ),
        stellar_account::stellar_account_exports::invoke_internal,
    );
    result.assert_abort();
    match into_root_call_result::<BytesM>(&result) {
        Err(sdk::call::RawCallError::Exception(error)) => {
            assert!(
                error.try_as::<erc20::ERC20Error>().is_some(),
                "the token's own error, got {error:?}"
            );
        }
        other => panic!("expected the child's exception, got {other:?}"),
    }
}

/// The `StellarAccount::master_key` entrypoint ID.
///
/// Same formula as `erc20_transfer_entrypoint`:
/// sha256(INTERFACE_NAME ++ "::" ++ MAJOR_VERSION ++ "::" ++ METHOD_NAME)[0..8].
/// For stellar-account 0.1.0 (inherent impl, interface name = "StellarAccount"):
/// interface = "StellarAccount", major = "0.1", method = "master_key".
fn stellar_account_master_key_entrypoint() -> ContractEntrypointID {
    let h: [u8; 32] = sdk::hash_to_array!("StellarAccount::0.1::master_key");
    ContractEntrypointID::from([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]])
}

/// A target without the requested entrypoint aborts with the SDK's
/// `LibraryExn::UnknownMethod` (the dispatcher's undefined-method hook, on
/// rv32 as on the native executor); `invoke` re-raises that abort verbatim
/// like any other child abort. It is not a fault, so not `CallFaulted`.
#[test]
fn invoke_of_an_unknown_entrypoint_re_raises_the_targets_unknown_method_abort() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(
            TOKEN,
            ContractEntrypointID::from([0xFF; 8]),
            u64::MAX,
            &[] as &[u8],
        ),
        stellar_account::stellar_account_exports::invoke_internal,
    );
    result.assert_abort();
    match into_root_call_result::<BytesM>(&result) {
        Err(sdk::call::RawCallError::Exception(error)) => {
            assert_eq!(
                error.try_as::<sdk::exn::LibraryExn>(),
                Some(sdk::exn::LibraryExn::UnknownMethod)
            );
        }
        other => panic!("expected the target's UnknownMethod abort, got {other:?}"),
    }
}

/// The account invokes itself (reentrance): must surface as a fault, not a
/// hang or silent success. Uses a known entrypoint (`master_key`) so the
/// failure must come from reentrance detection, not from an absent entrypoint.
#[test]
fn invoke_into_itself_is_a_fault_not_a_hang() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(
            ACCOUNT,
            stellar_account_master_key_entrypoint(),
            u64::MAX,
            &[] as &[u8],
        ),
        stellar_account::stellar_account_exports::invoke_internal,
    );
    assert_account_error(&result, AccountError::CallFaulted);
}

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
fn remove_signer_rejects_slot_zero_out_of_range_and_empty_slots() {
    let env = setup();
    for slot in [0u32, MAX_SIGNERS as u32, 5] {
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

const FACTORY: ContractAddress = ContractAddress::new([0x50; 32]);
const STARTING_BALANCE: u128 = 300;

/// A factory whose native token is `TOKEN`, so the account's `MINTED`
/// balance is what funds a new account. `account_hash` comes from
/// `setup_with_hash()`; the account package is registered only there.
fn setup_factory(env: &TestEnvironmentHandle, account_hash: SHA256Hash) {
    stellar_account_factory::register_mock_contract(env).deploy_contract_to(&FACTORY);
    env.transact(|tx| {
        tx.call(&ROOT).run(move || {
            stellar_account_factory::StellarAccountFactoryClient::new(&FACTORY).initialize(
                stellar_account_factory::FactoryConfig {
                    account_code_hash: account_hash,
                    native_token: TOKEN,
                    required_funding: STARTING_BALANCE,
                },
            )
        })
    })
    .assert_success();
    env.advance_block();
}

#[test]
fn create_account_funds_and_creates_a_second_account_in_one_frame() {
    let (env, account_hash) = setup_with_hash();
    setup_factory(&env, account_hash);
    let result = as_account(
        &env,
        claim(1),
        &(FACTORY, second_key(), STARTING_BALANCE),
        stellar_account::stellar_account_exports::create_account_internal,
    );
    result.assert_success();
    let created: ContractAddress = result.assert_return_as();
    assert_eq!(
        result
            .filter_events::<stellar_account::AccountCreated>(&FACTORY)
            .len(),
        1
    );
    env.advance_block();

    assert_eq!(balance_of(&env, created), STARTING_BALANCE);
    assert_eq!(balance_of(&env, ACCOUNT), MINTED - STARTING_BALANCE);
    let key = env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || StellarAccountClient::new(&created).master_key())
    });
    key.assert_success();
    assert_eq!(key.assert_return_as::<Ed25519PublicKey>(), second_key());
}

#[test]
fn create_account_with_too_small_a_starting_balance_fails_whole() {
    let (env, account_hash) = setup_with_hash();
    setup_factory(&env, account_hash);
    let result = as_account(
        &env,
        claim(1),
        &(FACTORY, second_key(), STARTING_BALANCE - 1),
        stellar_account::stellar_account_exports::create_account_internal,
    );
    result.assert_abort();
    match into_root_call_result::<ContractAddress>(&result) {
        Err(sdk::call::RawCallError::Exception(e)) => {
            assert_eq!(
                e.try_as::<stellar_account::AccountFactoryError>(),
                Some(stellar_account::AccountFactoryError::InsufficientFunding),
            );
        }
        other => panic!("expected InsufficientFunding, got {other:?}"),
    }
    env.advance_block();
    assert_eq!(
        balance_of(&env, ACCOUNT),
        MINTED,
        "the prefund was rolled back too"
    );
}

fn thresholds(env: &TestEnvironmentHandle) -> Thresholds {
    let result = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| StellarAccountClient::new(&ACCOUNT).thresholds())
    });
    result.assert_success();
    result.assert_return_as()
}

const ONES: Thresholds = Thresholds {
    low: 1,
    medium: 1,
    high: 1,
};

/// `low` is the chain-enforced required weight: above the total weight, no
/// transaction would ever be admitted again.
#[test]
fn a_low_threshold_above_the_total_weight_is_refused() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(2u32, 1u32, 1u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    result.assert_no_events();
    env.advance_block();
    assert_eq!(thresholds(&env), ONES, "nothing was written");
}

/// A medium threshold above the total weight would make payments dead.
#[test]
fn a_medium_threshold_above_the_total_weight_is_refused() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(1u32, 2u32, 1u32),
        stellar_account::stellar_account_exports::set_thresholds_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    result.assert_no_events();
    env.advance_block();
    assert_eq!(thresholds(&env), ONES, "nothing was written");
}

/// Removing a signer whose weight the low threshold depends on.
#[test]
fn removing_a_signer_below_the_low_threshold_is_refused() {
    let env = setup();
    add_second_signer(&env, 1).assert_success();
    env.advance_block();
    raise_thresholds(&env, 2, 1, 1);
    let result = as_account(
        &env,
        claim(1),
        &1u32,
        stellar_account::stellar_account_exports::remove_signer_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    env.advance_block();
    assert_eq!(weights(&env)[1], 1, "nothing was written");
}

/// Lowering a signer's weight below the high threshold.
#[test]
fn lowering_a_signer_weight_below_the_high_threshold_is_refused() {
    let env = setup();
    add_second_signer(&env, 2).assert_success();
    env.advance_block();
    raise_thresholds(&env, 1, 1, 3);
    let result = as_account(
        &env,
        claim(3),
        &(1u32, second_key(), 1u32),
        stellar_account::stellar_account_exports::set_signer_internal,
    );
    assert_account_error(&result, AccountError::WouldLockOut);
    env.advance_block();
    assert_eq!(weights(&env)[1], 2, "nothing was written");
}

// The chain's side: these observe the registration and required weight the
// native executor stores for the account, through its own auth verifier.

const THIRD_SEED: [u8; 32] = [0x33; 32];

fn set_thresholds_at(
    env: &TestEnvironmentHandle,
    weight: u32,
    t: (u32, u32, u32),
) -> TransactResult {
    as_account(
        env,
        claim(weight),
        &t,
        stellar_account::stellar_account_exports::set_thresholds_internal,
    )
}

fn set_master_weight_at(
    env: &TestEnvironmentHandle,
    weight: u32,
    master_weight: u32,
) -> TransactResult {
    as_account(
        env,
        claim(weight),
        &master_weight,
        stellar_account::stellar_account_exports::set_master_weight_internal,
    )
}

#[test]
fn the_chain_requires_both_signers_for_a_claim_of_two() {
    let env = setup();
    add_second_signer(&env, 1).assert_success();
    env.advance_block();
    raise_thresholds(&env, 1, 1, 2);

    assert!(
        !chain_accepts(&env, &[(0, &MASTER_SEED)], 2),
        "the master's weight 1 does not reach a claim of 2"
    );
    assert!(
        chain_accepts(&env, &[(0, &MASTER_SEED), (1, &SECOND_SEED)], 2),
        "master plus the registered second signer do"
    );
    assert!(
        !chain_accepts(&env, &[(0, &MASTER_SEED), (1, &THIRD_SEED)], 2),
        "an unregistered key at slot 1 does not"
    );
}

#[test]
fn master_weight_zero_then_four_re_registers_the_creation_key_on_the_chain() {
    let env = setup();
    add_second_signer(&env, 1).assert_success();
    env.advance_block();

    set_master_weight_at(&env, 1, 0).assert_success();
    env.advance_block();
    assert!(
        !chain_accepts(&env, &[(0, &MASTER_SEED)], 1),
        "slot 0 is deregistered"
    );
    assert!(chain_accepts(&env, &[(1, &SECOND_SEED)], 1));

    set_master_weight_at(&env, 1, 4).assert_success();
    env.advance_block();
    assert!(
        chain_accepts(&env, &[(0, &MASTER_SEED)], 4),
        "the creation key is back at slot 0 with weight 4"
    );
    assert!(
        !chain_accepts(&env, &[(0, &MASTER_SEED)], 5),
        "and with exactly weight 4"
    );
}

#[test]
fn a_refused_change_leaves_the_chain_registration_and_required_weight_unchanged() {
    let env = setup();
    add_second_signer(&env, 2).assert_success();
    env.advance_block();
    raise_thresholds(&env, 1, 1, 3);
    let both = [(0, &MASTER_SEED), (1, &SECOND_SEED)];
    let with_third = [(0, &MASTER_SEED), (1, &THIRD_SEED)];
    assert!(chain_accepts(&env, &both, 3));
    assert!(!chain_accepts(&env, &with_third, 1));

    // Re-keying slot 1 to a third key at weight 1 drops the total to 2,
    // below high: refused after the registration syscall was issued.
    let refused = as_account(
        &env,
        claim(3),
        &(1u32, key_from(&THIRD_SEED), 1u32),
        stellar_account::stellar_account_exports::set_signer_internal,
    );
    assert_account_error(&refused, AccountError::WouldLockOut);
    // A low above the total: refused after the required-weight syscall.
    assert_account_error(
        &set_thresholds_at(&env, 3, (5, 1, 3)),
        AccountError::WouldLockOut,
    );
    env.advance_block();

    assert!(
        chain_accepts(&env, &both, 3),
        "slot 1 still holds the second key at weight 2"
    );
    assert!(
        !chain_accepts(&env, &with_third, 1),
        "the third key never reached the chain"
    );
    assert!(
        chain_accepts(&env, &[(0, &MASTER_SEED)], 1),
        "the chain's required weight is still 1, not 5"
    );
}

#[test]
fn the_chain_enforces_low_even_when_the_claim_is_lower() {
    let env = setup();
    add_second_signer(&env, 1).assert_success();
    env.advance_block();
    raise_thresholds(&env, 2, 2, 2);

    assert!(
        !chain_accepts(&env, &[(0, &MASTER_SEED)], 1),
        "hogd requires max(stored 2, claimed 1)"
    );
    assert!(!chain_accepts(&env, &[(1, &SECOND_SEED)], 1));
    assert!(chain_accepts(
        &env,
        &[(0, &MASTER_SEED), (1, &SECOND_SEED)],
        1
    ));
}

/// The master key already owns slot 0; a second slot would double its weight.
#[test]
fn set_signer_refuses_the_master_key_in_another_slot() {
    let env = setup();
    let result = as_account(
        &env,
        claim(1),
        &(1u32, master_key(), 1u32),
        stellar_account::stellar_account_exports::set_signer_internal,
    );
    assert_account_error(&result, AccountError::InvalidSlot);
    env.advance_block();
    assert_eq!(weights(&env)[1], 0, "nothing was written");
}

/// `set_master_weight(0)` when slot 0 is already empty has nothing to remove.
#[test]
fn master_weight_zero_on_an_empty_slot_zero_is_refused() {
    let env = setup();
    add_second_signer(&env, 1).assert_success();
    env.advance_block();
    set_master_weight_at(&env, 1, 0).assert_success();
    env.advance_block();
    let result = set_master_weight_at(&env, 1, 0);
    assert_account_error(&result, AccountError::InvalidSlot);
    result.assert_no_events();
}
