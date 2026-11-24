//! Native tests for the factory: funded creation at a predicted address, the
//! drop list, rollback, and serialized creation.

use nft_drop::{DropDefinition, NftDropClient, Trait, TraitValue};
use nft_drop_factory::*;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::call::RawCallError;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

const BASE_FUNDING: i128 = 1_000;
const FUNDING_PER_TOKEN: i128 = 10;

fn factory() -> ContractAddress {
    ContractAddress::named("factory")
}
fn creator() -> ContractAddress {
    ContractAddress::named("creator")
}
fn nonce(n: u8) -> SHA256Hash {
    SHA256Hash::new([n; 32])
}

fn definition(supply: u32) -> DropDefinition {
    let value = |name: &str, weight| TraitValue {
        name: name.try_into().unwrap(),
        weight,
    };
    DropDefinition {
        name: "Critters".try_into().unwrap(),
        symbol: "CRIT".try_into().unwrap(),
        supply,
        traits: VecM(vec![Trait {
            name: "Body".try_into().unwrap(),
            values: VecM(vec![value("Round", 1), value("Square", 1)]),
        }]),
    }
}

/// Give `who` native tokens, as a faucet would.
fn grant(env: &TestEnvironmentHandle, who: &ContractAddress, amount: i128) {
    env.setup_grant_storage_tokens(who, i64::try_from(amount).unwrap());
}

fn setup() -> TestEnvironmentHandle {
    let env = TestEnvironment::no_cost();
    let drop_code_hash = *nft_drop::register_mock_contract(&env).as_hash();
    nft_drop_factory::register_mock_contract(&env).deploy_contract_to(&factory());
    env.transact(|tx| {
        tx.call(&creator()).run(move || {
            NftDropFactoryClient::new(&factory()).initialize(FactoryConfig {
                drop_code_hash,
                base_funding: BASE_FUNDING,
                funding_per_token: FUNDING_PER_TOKEN,
            })
        })
    })
    .assert_success();
    env.advance_block();
    env
}

fn predict(env: &TestEnvironmentHandle, who: ContractAddress, n: u8) -> ContractAddress {
    let result = env.transact(|tx| {
        tx.call(&who)
            .run(move || NftDropFactoryClient::new(&factory()).predict_drop(&who, &nonce(n)))
    });
    result.assert_success();
    result.assert_return_as()
}

fn create(env: &TestEnvironmentHandle, who: ContractAddress, n: u8, supply: u32) -> TransactResult {
    env.transact(|tx| {
        tx.call(&who).run(move || {
            NftDropFactoryClient::new(&factory()).create_drop(&nonce(n), definition(supply))
        })
    })
}

fn drop_count(env: &TestEnvironmentHandle) -> u64 {
    let result = env.transact(|tx| {
        tx.call(&creator())
            .run(|| NftDropFactoryClient::new(&factory()).drop_count())
    });
    result.assert_success();
    result.assert_return_as()
}

#[track_caller]
fn assert_factory_error(result: &TransactResult, expected: FactoryError) {
    result.assert_abort();
    match into_root_call_result::<ContractAddress>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<FactoryError>(), Some(expected));
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

#[test]
fn a_funded_drop_deploys_at_its_predicted_address_and_is_listed() {
    let env = setup();
    let predicted = predict(&env, creator(), 1);
    grant(&env, &predicted, BASE_FUNDING + FUNDING_PER_TOKEN * 50);

    let result = create(&env, creator(), 1, 50);
    result.assert_success();
    assert_eq!(result.assert_return_as::<ContractAddress>(), predicted);
    env.advance_block();

    assert_eq!(drop_count(&env), 1);
    let listed = env.transact(|tx| {
        tx.call(&creator())
            .run(|| NftDropFactoryClient::new(&factory()).drop_at(0))
    });
    assert_eq!(listed.assert_return_as::<ContractAddress>(), predicted);

    // The new drop is initialized with its creator, and minting is open.
    let config = env.transact(|tx| {
        tx.call(&creator())
            .run(move || NftDropClient::new(&predicted).get_config())
    });
    let config = config.assert_return_as::<nft_drop::DropConfig>();
    assert_eq!((config.creator, config.supply), (creator(), 50));
    env.transact(|tx| {
        tx.call(&ContractAddress::named("minter"))
            .run(move || NftDropClient::new(&predicted).mint())
    })
    .assert_success();
}

#[test]
fn an_underfunded_drop_is_refused() {
    let env = setup();
    let predicted = predict(&env, creator(), 1);
    grant(&env, &predicted, BASE_FUNDING + FUNDING_PER_TOKEN * 50 - 1);

    assert_factory_error(
        &create(&env, creator(), 1, 50),
        FactoryError::InsufficientFunding,
    );
    env.advance_block();
    assert_eq!(drop_count(&env), 0);
}

// The drop validates its definition. Its abort fails the whole creation, so
// nothing is deployed and nothing is listed.
#[test]
fn an_invalid_definition_creates_nothing() {
    let env = setup();
    let predicted = predict(&env, creator(), 1);
    grant(&env, &predicted, BASE_FUNDING);

    create(&env, creator(), 1, 0).assert_abort();
    env.advance_block();
    assert_eq!(drop_count(&env), 0);
}

// The app's path: one transaction funds the predicted address and then
// creates the drop, so the creator signs once.
#[test]
fn one_transaction_can_fund_and_create() {
    let env = setup();
    grant(&env, &creator(), 10_000);
    env.advance_block();
    let predicted = predict(&env, creator(), 7);

    let result = env.transact(|tx| {
        tx.call(&creator()).run(move || {
            let funding = BASE_FUNDING + FUNDING_PER_TOKEN * 100;
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&predicted, funding);
            NftDropFactoryClient::new(&factory()).create_drop(&nonce(7), definition(100))
        })
    });
    result.assert_success();
    assert_eq!(result.assert_return_as::<ContractAddress>(), predicted);
}

// Creation writes the list's count, so a second creation in the same block
// is excluded. Minting never touches the factory, so this does not limit it.
#[test]
fn only_one_drop_is_created_per_block() {
    let env = setup();
    let other = ContractAddress::named("other");
    for (who, n) in [(creator(), 1), (other, 2)] {
        let predicted = predict(&env, who, n);
        grant(&env, &predicted, BASE_FUNDING + FUNDING_PER_TOKEN * 10);
    }
    env.advance_block();

    create(&env, creator(), 1, 10).assert_success();
    create(&env, other, 2, 10).assert_commit_failed_nondeterministically();
    env.advance_block();
    assert_eq!(drop_count(&env), 1);

    create(&env, other, 2, 10).assert_success();
    env.advance_block();
    assert_eq!(drop_count(&env), 2);
}

#[test]
fn the_factory_initializes_once() {
    let env = setup();
    let again = env.transact(|tx| {
        tx.call(&creator()).run(|| {
            NftDropFactoryClient::new(&factory()).initialize(FactoryConfig {
                drop_code_hash: SHA256Hash::new([9; 32]),
                base_funding: 0,
                funding_per_token: 0,
            })
        })
    });
    again.assert_abort();
}
