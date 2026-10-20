//! Both `#[contract]` surfaces of `mixed-impl`, driven through the clients the
//! macro generates for each.

use mixed_impl::*;
use thruput_sdk::*;

static CONTRACT_NONCE: SHA256Hash = thruput_sdk::sha256_static!("MIXED_IMPL");

/// Helper: register the contract. `register_mock_contract` picks up every
/// `#[contract]` export in the crate, so one call covers both the inherent
/// impl and the trait impl.
fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = mixed_impl::register_mock_contract(&env);
    let contract_hash = *contract.as_hash();
    (env, contract_hash)
}

/// The inherent (`notrait`) surface, reached through `VaultClient`.
#[test]
fn test_inherent_surface() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let vault = VaultClient::new(&addr);

            // Unset storage reads as 0.
            assert_eq!(vault.get(), 0);

            vault.set(42);
            assert_eq!(vault.get(), 42);
        })
    });
    result.assert_success();
}

/// The trait surface, reached through the trait's `ResettableClient`.
#[test]
fn test_trait_surface() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let vault = VaultClient::new(&addr);
            let resettable = ResettableClient::new(&addr);

            vault.set(7);
            resettable.reset();

            assert_eq!(vault.get(), 0);
        })
    });
    result.assert_success();
}

/// Both surfaces on one deployed contract, sharing one storage struct.
#[test]
fn test_both_surfaces_same_contract() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);

            // Two clients, two interfaces, one address.
            let vault = VaultClient::new(&addr);
            let resettable = ResettableClient::new(&addr);

            vault.set(100);
            assert_eq!(vault.get(), 100);

            // The trait method mutates the state the inherent methods read.
            resettable.reset();
            assert_eq!(vault.get(), 0);

            vault.set(5);
            assert_eq!(vault.get(), 5);
        })
    });
    result.assert_success();
}

/// `throws` declared on the inherent impl is published in the interface's
/// spec; the caller decodes the thrown error by selector.
#[test]
fn test_inherent_surface_throws() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let vault = VaultClient::new(&addr);

            let err = vault.try_set(1_000_001).unwrap_err();
            assert_eq!(err.try_as(), Some(VaultError::ValueTooLarge));
        })
    });
    result.assert_success();
}

/// `throws` declared on the trait definition behaves the same way.
#[test]
fn test_trait_surface_throws() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deploy_contract(&CONTRACT_NONCE, &contract_hash);
            let resettable = ResettableClient::new(&addr);

            // Nothing has been set, so the vault is already at zero.
            let err = resettable.try_reset().unwrap_err();
            assert_eq!(err.try_as(), Some(ResettableError::AlreadyReset));
        })
    });
    result.assert_success();
}
