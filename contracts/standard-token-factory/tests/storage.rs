use groundhog_erc20_if::ERC20Client;
use groundhog_xdr::storage_item::WireStorageItem;
use sdk::*;
use standard_token::{Config, allowance_storage_key, balance_storage_key, config_storage_key};
use standard_token_factory::{Amount, FactoryConfig, Name, StandardTokenFactoryClient, Symbol};
use token_factory_test_if::TokenFactoryTestWalletClient;

const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
const ADMIN: ContractAddress = ContractAddress::new([0x20; 32]);
const HOLDER: ContractAddress = ContractAddress::new([0x30; 32]);
const RECEIVER_A: ContractAddress = ContractAddress::new([0x40; 32]);
const RECEIVER_B: ContractAddress = ContractAddress::new([0x41; 32]);
const SPENDER_A: ContractAddress = ContractAddress::new([0x50; 32]);
const SPENDER_B: ContractAddress = ContractAddress::new([0x51; 32]);
const NATIVE_NONCE: SHA256Hash = SHA256Hash::new([0x61; 32]);
const WALLET_NONCE: SHA256Hash = SHA256Hash::new([0x62; 32]);
const FACTORY_NONCE: SHA256Hash = SHA256Hash::new([0x63; 32]);
const TOKEN_A_NONCE: SHA256Hash = SHA256Hash::new([0x71; 32]);
const TOKEN_B_NONCE: SHA256Hash = SHA256Hash::new([0x72; 32]);
const SETUP_GRANT: i64 = 1_000_000_000;

#[derive(Clone)]
struct Creation {
    nonce: SHA256Hash,
    name: Option<Name>,
    symbol: Option<Symbol>,
    decimals: Option<u32>,
    supply: Amount,
}

impl Creation {
    fn new(nonce: SHA256Hash, supply: Amount) -> Self {
        Self {
            nonce,
            name: Some("Storage Token".try_into().unwrap()),
            symbol: Some("STO".try_into().unwrap()),
            decimals: Some(9),
            supply,
        }
    }

    fn config(&self) -> Config {
        Config {
            administrator: ADMIN,
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            decimals: self.decimals,
        }
    }
}

struct Setup {
    env: TestEnvironmentHandle,
    factory: ContractAddress,
    wallet: ContractAddress,
    native_token: ContractAddress,
}

fn setup() -> Setup {
    let env = TestEnvironment::default();
    let token_hash = *standard_token::register_mock_contract(&env).as_hash();
    let factory_hash = *standard_token_factory::register_mock_contract(&env).as_hash();
    let wallet_hash = *token_factory_test_wallet::register_mock_contract(&env).as_hash();
    let addresses = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            (
                get_deploy_address(&NATIVE_NONCE, &token_hash),
                get_deploy_address(&WALLET_NONCE, &wallet_hash),
                get_deploy_address(&FACTORY_NONCE, &factory_hash),
            )
        })
    });
    addresses.assert_success();
    let (native_token, wallet, factory) = addresses.assert_return_as();
    for address in [ROOT, native_token, wallet, factory] {
        env.setup_grant_storage_tokens(&address, SETUP_GRANT);
    }

    let deployed = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let native_token = deploy_contract(&NATIVE_NONCE, &token_hash);
            let wallet = deploy_contract(&WALLET_NONCE, &wallet_hash);
            let factory = deploy_contract(&FACTORY_NONCE, &factory_hash);
            let native = ERC20Client::new(&native_token);
            native.initialize(&ROOT);
            native.mint(&ROOT, 1_000_000);
            native.transfer(&wallet, 100_000);
            StandardTokenFactoryClient::new(&factory).initialize(FactoryConfig {
                token_code_hash: token_hash,
                required_token_funding: 1,
                native_token,
                creation_fee: 0,
                fee_recipient: None,
            });
            (native_token, wallet, factory)
        })
    });
    deployed.assert_success();
    env.advance_block();

    Setup {
        env,
        factory,
        wallet,
        native_token,
    }
}

fn predict(setup: &Setup, creation: &Creation) -> ContractAddress {
    let wallet = setup.wallet;
    let factory = setup.factory;
    let nonce = creation.nonce;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| TokenFactoryTestWalletClient::new(&wallet).predict_token(&factory, &nonce))
    });
    result.assert_success();
    result.assert_return_as()
}

fn host_initial_cost(setup: &Setup, creation: &Creation) -> i64 {
    let model = setup.env.get_current_cost_model();
    let config_len = encode_xdr(&creation.config()).unwrap().len();
    // The host fixture charges mock deployment to the deployer. This boundary
    // intentionally measures only child-owned initialization state.
    let mut cost = model.bytestring_cost(config_len) + model.nnint_cost();
    if creation.supply != 0 {
        cost += model.nnint_cost();
    }
    cost.try_into().unwrap()
}

fn prepare_creation(
    setup: &Setup,
    creation: &Creation,
    storage_grant: i64,
) -> (ContractAddress, TransactResult) {
    let predicted = predict(setup, creation);
    setup
        .env
        .setup_grant_storage_tokens(&predicted, storage_grant);
    let wallet = setup.wallet;
    let native_token = setup.native_token;
    let funded = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet).fund_token(&native_token, &predicted, 1)
        })
    });
    funded.assert_success();
    setup.env.advance_block();

    let factory = setup.factory;
    let creation = creation.clone();
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(&wallet).create_token(
                &factory,
                &creation.nonce,
                &ADMIN,
                creation.name,
                creation.symbol,
                creation.decimals,
                &HOLDER,
                creation.supply,
            )
        })
    });
    (predicted, result)
}

fn assert_nnint(
    env: &TestEnvironmentHandle,
    token: &ContractAddress,
    key: StorageKey,
    value: i128,
) {
    match env.get_snapshot_storage_item(token, &key) {
        Some(WireStorageItem::kItemTypeNonnegativeInt { nnint }) => {
            assert_eq!(i128::from(nnint), value)
        }
        other => panic!("expected NNInt {value} at {key:?}, got {other:?}"),
    }
}

fn balance_key(setup: &Setup, token: ContractAddress, owner: ContractAddress) -> StorageKey {
    let result = setup
        .env
        .transact(|tx| tx.call(&token).run(|| balance_storage_key(&owner)));
    result.assert_success();
    result.assert_return_as()
}

fn allowance_key(
    setup: &Setup,
    token: ContractAddress,
    owner: ContractAddress,
    spender: ContractAddress,
) -> StorageKey {
    let result = setup.env.transact(|tx| {
        tx.call(&token)
            .run(|| allowance_storage_key(&owner, &spender))
    });
    result.assert_success();
    result.assert_return_as()
}

fn config_key(setup: &Setup, token: ContractAddress) -> StorageKey {
    let result = setup
        .env
        .transact(|tx| tx.call(&token).run(config_storage_key));
    result.assert_success();
    result.assert_return_as()
}

fn token_call<T: WriteXDR>(
    setup: &Setup,
    caller: ContractAddress,
    operation: impl FnOnce() -> T + std::panic::UnwindSafe,
) -> TransactResult {
    setup.env.transact(|tx| tx.call(&caller).run(operation))
}

#[test]
fn factory_created_zero_supply_materializes_the_holder_row() {
    let setup = setup();
    let creation = Creation::new(TOKEN_A_NONCE, 0);
    let cost = host_initial_cost(&setup, &creation);
    let (token, result) = prepare_creation(&setup, &creation, cost);
    result.assert_success();
    setup.env.advance_block();

    assert_nnint(&setup.env, &token, balance_key(&setup, token, HOLDER), 0);
    let supply = token_call(&setup, ROOT, || ERC20Client::new(&token).total_supply());
    supply.assert_success();
    assert_eq!(supply.assert_return_as::<Amount>(), 0);

    let native_token = setup.native_token;
    let native_balance = token_call(&setup, ROOT, || {
        ERC20Client::new(&native_token).get_balance_of(&token)
    });
    native_balance.assert_success();
    assert_eq!(native_balance.assert_return_as::<Amount>(), 1);
}

#[test]
fn host_initial_storage_boundary_fails_one_below_and_succeeds_at_exact_cost() {
    let underfunded = setup();
    let creation = Creation::new(TOKEN_A_NONCE, 1_000);
    let cost = host_initial_cost(&underfunded, &creation);
    let (predicted, failed) = prepare_creation(&underfunded, &creation, cost - 1);
    failed.frame().assert_success();
    failed.assert_commit_failed_nondeterministically();
    underfunded.env.advance_block();
    assert!(
        underfunded
            .env
            .get_snapshot_storage_item(&predicted, &config_key(&underfunded, predicted))
            .is_none()
    );

    let exact = setup();
    let cost = host_initial_cost(&exact, &creation);
    let (token, succeeded) = prepare_creation(&exact, &creation, cost);
    succeeded.assert_success();
    exact.env.advance_block();
    assert!(
        exact
            .env
            .get_snapshot_storage_item(&token, &config_key(&exact, token))
            .is_some()
    );
    assert_nnint(
        &exact.env,
        &token,
        balance_key(&exact, token, HOLDER),
        1_000,
    );
    let supply = token_call(&exact, ROOT, || ERC20Client::new(&token).total_supply());
    supply.assert_success();
    assert_eq!(supply.assert_return_as::<Amount>(), 1_000);
}

#[test]
fn new_balance_rows_consume_only_their_tokens_reserve() {
    let setup = setup();
    let row_cost: i64 = setup
        .env
        .get_current_cost_model()
        .nnint_cost()
        .try_into()
        .unwrap();
    let creation_a = Creation::new(TOKEN_A_NONCE, 1_000);
    let creation_b = Creation::new(TOKEN_B_NONCE, 1_000);
    let cost = host_initial_cost(&setup, &creation_a);
    let (token_a, created_a) = prepare_creation(&setup, &creation_a, cost + row_cost);
    created_a.assert_success();
    setup.env.advance_block();
    let (token_b, created_b) = prepare_creation(&setup, &creation_b, cost + row_cost);
    created_b.assert_success();
    setup.env.advance_block();

    token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_a).transfer(&RECEIVER_A, 100)
    })
    .assert_success();
    setup.env.advance_block();
    let exhausted = token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_a).transfer(&RECEIVER_B, 100)
    });
    exhausted.frame().assert_success();
    exhausted.assert_commit_failed_nondeterministically();
    setup.env.advance_block();
    assert!(
        setup
            .env
            .get_snapshot_storage_item(&token_a, &balance_key(&setup, token_a, RECEIVER_B),)
            .is_none()
    );

    token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_a).transfer(&RECEIVER_A, 25)
    })
    .assert_success();
    setup.env.advance_block();
    token_call(&setup, RECEIVER_A, || {
        ERC20Client::new(&token_a).transfer(&HOLDER, 10)
    })
    .assert_success();
    setup.env.advance_block();

    token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_b).transfer(&RECEIVER_B, 100)
    })
    .assert_success();
    setup.env.advance_block();
    assert_nnint(
        &setup.env,
        &token_a,
        balance_key(&setup, token_a, RECEIVER_A),
        115,
    );
    assert_nnint(
        &setup.env,
        &token_b,
        balance_key(&setup, token_b, RECEIVER_B),
        100,
    );
}

#[test]
fn allowance_rows_are_isolated_and_existing_rows_need_no_new_reserve() {
    let setup = setup();
    let row_cost: i64 = setup
        .env
        .get_current_cost_model()
        .nnint_cost()
        .try_into()
        .unwrap();
    let creation_a = Creation::new(TOKEN_A_NONCE, 1_000);
    let creation_b = Creation::new(TOKEN_B_NONCE, 1_000);
    let cost = host_initial_cost(&setup, &creation_a);
    let (token_a, created_a) = prepare_creation(&setup, &creation_a, cost + row_cost);
    created_a.assert_success();
    setup.env.advance_block();
    let (token_b, created_b) = prepare_creation(&setup, &creation_b, cost + row_cost);
    created_b.assert_success();
    setup.env.advance_block();

    token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_a).adjust_allowance(&SPENDER_A, 100)
    })
    .assert_success();
    setup.env.advance_block();
    token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_a).adjust_allowance(&SPENDER_A, 50)
    })
    .assert_success();
    setup.env.advance_block();
    let exhausted = token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_a).adjust_allowance(&SPENDER_B, 1)
    });
    exhausted.frame().assert_success();
    exhausted.assert_commit_failed_nondeterministically();
    setup.env.advance_block();

    token_call(&setup, HOLDER, || {
        ERC20Client::new(&token_b).adjust_allowance(&SPENDER_B, 100)
    })
    .assert_success();
    setup.env.advance_block();
    assert_nnint(
        &setup.env,
        &token_a,
        allowance_key(&setup, token_a, HOLDER, SPENDER_A),
        150,
    );
    assert!(
        setup
            .env
            .get_snapshot_storage_item(
                &token_a,
                &allowance_key(&setup, token_a, HOLDER, SPENDER_B),
            )
            .is_none()
    );
    assert_nnint(
        &setup.env,
        &token_b,
        allowance_key(&setup, token_b, HOLDER, SPENDER_B),
        100,
    );
}
