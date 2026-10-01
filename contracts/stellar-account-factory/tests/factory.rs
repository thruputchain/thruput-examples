//! Creation and derivation on the native executor. ROOT is a plain caller;
//! the native token is the `erc20` example.

use ed25519_dalek::SigningKey;
use sdk::call::RawCallError;
use sdk::*;
use stellar_account::{AccountInitError, MAX_SIGNERS, StellarAccountClient, Thresholds};
use stellar_account_factory::{
    AccountCreated, AccountFactoryError, FactoryConfig, StellarAccountFactoryClient,
    StellarAccountInitializerClient,
};

const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
const FACTORY: ContractAddress = ContractAddress::new([0x50; 32]);
const NATIVE: ContractAddress = ContractAddress::new([0x60; 32]);
const REQUIRED_FUNDING: u128 = 100;

fn key(seed: u8) -> Ed25519PublicKey {
    Ed25519PublicKey::from(
        SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .to_bytes(),
    )
}

struct Setup {
    env: TestEnvironmentHandle,
    account_hash: SHA256Hash,
}

fn setup() -> Setup {
    let env = TestEnvironment::no_cost();
    let account_hash = *stellar_account::register_mock_contract(&env).as_hash();
    stellar_account_factory::register_mock_contract(&env).deploy_contract_to(&FACTORY);
    erc20::register_mock_contract(&env).deploy_contract_to(&NATIVE);
    env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let native = erc20::ERC20Client::new(&NATIVE);
            native.initialize(&ROOT);
            native.mint(&ROOT, 1_000_000);
            StellarAccountFactoryClient::new(&FACTORY).initialize(FactoryConfig {
                account_code_hash: account_hash,
                native_token: NATIVE,
                required_funding: REQUIRED_FUNDING,
            });
        })
    })
    .assert_success();
    env.advance_block();
    Setup { env, account_hash }
}

fn address_of(s: &Setup, master: Ed25519PublicKey) -> ContractAddress {
    let r = s.env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || StellarAccountFactoryClient::new(&FACTORY).address_of(&master))
    });
    r.assert_success();
    r.assert_return_as()
}

fn fund(s: &Setup, to: ContractAddress, amount: u128) {
    s.env
        .transact(|tx| {
            tx.call(&ROOT)
                .run(move || erc20::ERC20Client::new(&NATIVE).transfer(&to, amount))
        })
        .assert_success();
    s.env.advance_block();
}

fn create(s: &Setup, master: Ed25519PublicKey) -> TransactResult {
    s.env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || StellarAccountFactoryClient::new(&FACTORY).create_account(&master))
    })
}

fn assert_factory_error(result: &TransactResult, expected: AccountFactoryError) {
    result.assert_abort();
    match into_root_call_result::<ContractAddress>(result) {
        Err(RawCallError::Exception(e)) => {
            assert_eq!(e.try_as::<AccountFactoryError>(), Some(expected))
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

#[test]
fn create_account_lands_at_address_of_and_initializes_in_the_same_frame() {
    let s = setup();
    let master = key(0x11);
    let predicted = address_of(&s, master);
    let account_hash = s.account_hash;
    let helper = s.env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || stellar_account_factory::account_address(&FACTORY, &account_hash, &master))
    });
    helper.assert_success();
    assert_eq!(
        helper.assert_return_as::<ContractAddress>(),
        predicted,
        "the pure helper agrees with the view"
    );
    fund(&s, predicted, REQUIRED_FUNDING);

    let result = create(&s, master);
    result.assert_success();
    assert_eq!(result.assert_return_as::<ContractAddress>(), predicted);
    assert_eq!(result.filter_events::<AccountCreated>(&FACTORY).len(), 1);
    s.env.advance_block();

    let state = s.env.transact(|tx| {
        tx.call(&ROOT).run(move || {
            let a = StellarAccountClient::new(&predicted);
            (a.master_key(), a.thresholds(), a.signer_weights())
        })
    });
    state.assert_success();
    let (k, t, w): (Ed25519PublicKey, Thresholds, [u32; MAX_SIGNERS]) = state.assert_return_as();
    assert_eq!(k, master);
    assert_eq!(
        t,
        Thresholds {
            low: 1,
            medium: 1,
            high: 1
        }
    );
    assert_eq!(w[0], 1);
    assert!(w[1..].iter().all(|x| *x == 0));
}

#[test]
fn an_unfunded_prediction_is_refused() {
    let s = setup();
    let master = key(0x12);
    fund(&s, address_of(&s, master), REQUIRED_FUNDING - 1);
    assert_factory_error(
        &create(&s, master),
        AccountFactoryError::InsufficientFunding,
    );
}

#[test]
fn a_created_account_cannot_be_initialized_again() {
    let s = setup();
    let master = key(0x13);
    let account = address_of(&s, master);
    fund(&s, account, REQUIRED_FUNDING);
    create(&s, master).assert_success();
    s.env.advance_block();
    s.env
        .transact(|tx| {
            tx.call(&ROOT).run(move || {
                let r = StellarAccountInitializerClient::new(&account).try_initialize(&key(0x14));
                assert_eq!(
                    r.unwrap_err().try_as(),
                    Some(AccountInitError::AlreadyInitialized)
                );
            })
        })
        .assert_success();
}

#[test]
fn the_same_master_key_cannot_be_created_twice() {
    let s = setup();
    let master = key(0x15);
    let account = address_of(&s, master);
    fund(&s, account, REQUIRED_FUNDING);
    create(&s, master).assert_success();
    s.env.advance_block();
    fund(&s, account, REQUIRED_FUNDING);
    let second = create(&s, master);
    second.assert_abort();
}

#[test]
fn factory_initialize_validates_and_runs_once() {
    let s = setup();
    let again = s.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            StellarAccountFactoryClient::new(&FACTORY).initialize(FactoryConfig {
                account_code_hash: s.account_hash,
                native_token: NATIVE,
                required_funding: 1,
            })
        })
    });
    assert_factory_error_unit(&again, AccountFactoryError::AlreadyInitialized);

    let fresh = ContractAddress::new([0x51; 32]);
    stellar_account_factory::register_mock_contract(&s.env).deploy_contract_to(&fresh);
    let bad = s.env.transact(|tx| {
        tx.call(&ROOT).run(move || {
            StellarAccountFactoryClient::new(&fresh).initialize(FactoryConfig {
                account_code_hash: s.account_hash,
                native_token: NATIVE,
                required_funding: 0,
            })
        })
    });
    assert_factory_error_unit(&bad, AccountFactoryError::InvalidConfig);
}

fn assert_factory_error_unit(result: &TransactResult, expected: AccountFactoryError) {
    result.assert_abort();
    match into_root_call_result::<()>(result) {
        Err(RawCallError::Exception(e)) => {
            assert_eq!(e.try_as::<AccountFactoryError>(), Some(expected))
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

#[test]
fn the_master_key_formats_as_a_stellar_g_strkey() {
    let s = setup();
    let master = key(0x16);
    let account = address_of(&s, master);
    fund(&s, account, REQUIRED_FUNDING);
    create(&s, master).assert_success();
    s.env.advance_block();
    let got = s.env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || StellarAccountClient::new(&account).master_key())
    });
    got.assert_success();
    let got: Ed25519PublicKey = got.assert_return_as();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(got.as_ref());
    let g = groundhog_signing::strkey::format_public_key(&bytes);
    assert!(g.starts_with('G'), "{g}");
    assert_eq!(
        groundhog_signing::strkey::parse_public_key(&g).unwrap(),
        bytes
    );
}
