mod support;

use sdk::*;
use stellar_account::{AccountInitError, MAX_SIGNERS, StellarAccountClient, Thresholds};
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
