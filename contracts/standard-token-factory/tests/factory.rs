use groundhog_erc20_if::{CONTRACT_ADDR_ZERO, ERC20Client, ERC20Error, TransferEvent};
use sdk::call::RawCallError;
use sdk::*;
use standard_token::ERC20MetadataClient;
use standard_token_factory::*;
use standard_token_factory_if::predicted_token;
use token_factory_test_if::TokenFactoryTestWalletClient;

const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
const ADMIN: ContractAddress = ContractAddress::new([0x20; 32]);
const HOLDER: ContractAddress = ContractAddress::new([0x30; 32]);
const RECEIVER: ContractAddress = ContractAddress::new([0x40; 32]);
const SPENDER: ContractAddress = ContractAddress::new([0x50; 32]);
const FACTORY_NONCE: SHA256Hash = SHA256Hash::new([0x61; 32]);
const NATIVE_NONCE: SHA256Hash = SHA256Hash::new([0x62; 32]);
const WALLET_NONCE: SHA256Hash = SHA256Hash::new([0x63; 32]);
const SECOND_WALLET_NONCE: SHA256Hash = SHA256Hash::new([0x64; 32]);
const TOKEN_NONCE: SHA256Hash = SHA256Hash::new([0x71; 32]);
const SECOND_TOKEN_NONCE: SHA256Hash = SHA256Hash::new([0x72; 32]);
const MAX_SUPPLY_NONCE: SHA256Hash = SHA256Hash::new([0x73; 32]);
const REQUIRED_FUNDING: Amount = 100;

struct Setup {
    env: TestEnvironmentHandle,
    factory: ContractAddress,
    wallet: ContractAddress,
    native_token: ContractAddress,
    token_hash: SHA256Hash,
    wallet_hash: SHA256Hash,
    config: FactoryConfig,
}

fn config(token_hash: SHA256Hash, native_token: ContractAddress) -> FactoryConfig {
    FactoryConfig {
        token_code_hash: token_hash,
        required_token_funding: REQUIRED_FUNDING,
        native_token,
        creation_fee: 0,
        fee_recipient: None,
    }
}

fn setup() -> Setup {
    let env = TestEnvironment::no_cost();
    let token_hash = *standard_token::register_mock_contract(&env).as_hash();
    let factory_hash = *standard_token_factory::register_mock_contract(&env).as_hash();
    let wallet_hash = *token_factory_test_wallet::register_mock_contract(&env).as_hash();

    let deployed = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let native_token = deploy_contract(&NATIVE_NONCE, &token_hash);
            let wallet = deploy_contract(&WALLET_NONCE, &wallet_hash);
            let factory = deploy_contract(&FACTORY_NONCE, &factory_hash);

            let native = ERC20Client::new(&native_token);
            native.initialize(&ROOT);
            native.mint(&ROOT, 100_000);
            native.transfer(&wallet, 10_000);

            let factory_config = config(token_hash, native_token);
            StandardTokenFactoryClient::new(&factory).initialize(factory_config);
            (native_token, wallet, factory, factory_config)
        })
    });
    deployed.assert_success();
    let (native_token, wallet, factory, factory_config) = deployed.assert_return_as();
    env.advance_block();

    Setup {
        env,
        factory,
        wallet,
        native_token,
        token_hash,
        wallet_hash,
        config: factory_config,
    }
}

fn predict(setup: &Setup, wallet: &ContractAddress, nonce: &SHA256Hash) -> ContractAddress {
    let factory = setup.factory;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| TokenFactoryTestWalletClient::new(wallet).predict_token(&factory, nonce))
    });
    result.assert_success();
    result.assert_return_as()
}

fn fund(setup: &Setup, wallet: &ContractAddress, token: &ContractAddress, amount: Amount) {
    let native_token = setup.native_token;
    let result = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(wallet).fund_token(&native_token, token, amount)
        })
    });
    result.assert_success();
    setup.env.advance_block();
}

#[expect(
    clippy::too_many_arguments,
    reason = "the helper mirrors the fixed factory creation ABI"
)]
fn create(
    setup: &Setup,
    wallet: &ContractAddress,
    nonce: &SHA256Hash,
    administrator: &ContractAddress,
    name: Option<Name>,
    symbol: Option<Symbol>,
    decimals: Option<u32>,
    initial_holder: &ContractAddress,
    initial_supply: Amount,
) -> TransactResult {
    let factory = setup.factory;
    setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            TokenFactoryTestWalletClient::new(wallet).create_token(
                &factory,
                nonce,
                administrator,
                name,
                symbol,
                decimals,
                initial_holder,
                initial_supply,
            )
        })
    })
}

fn assert_factory_error(result: &TransactResult, expected: TokenFactoryError) {
    result.assert_abort();
    result.assert_no_events();
    match into_root_call_result::<ContractAddress>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<TokenFactoryError>(), Some(expected));
        }
        other => panic!("expected factory error {expected:?}, got {other:?}"),
    }
}

fn assert_init_error(result: &TransactResult, expected: TokenFactoryError) {
    result.assert_abort();
    result.assert_no_events();
    match into_root_call_result::<()>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<TokenFactoryError>(), Some(expected));
        }
        other => panic!("expected factory error {expected:?}, got {other:?}"),
    }
}

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

fn deploy_bare_factory(
    env: &TestEnvironmentHandle,
    factory_hash: &SHA256Hash,
    nonce_byte: u8,
) -> ContractAddress {
    let result = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| deploy_contract(&SHA256Hash::new([nonce_byte; 32]), factory_hash))
    });
    result.assert_success();
    let factory = result.assert_return_as();
    env.advance_block();
    factory
}

#[test]
fn initialization_validates_configuration_and_exposes_immutable_views() {
    let env = TestEnvironment::no_cost();
    let factory_hash = *standard_token_factory::register_mock_contract(&env).as_hash();
    let valid = config(
        SHA256Hash::new([0x81; 32]),
        ContractAddress::new([0x82; 32]),
    );

    let invalid = [
        FactoryConfig {
            token_code_hash: SHA256Hash::new([0; 32]),
            ..valid
        },
        FactoryConfig {
            native_token: *CONTRACT_ADDR_ZERO,
            ..valid
        },
        FactoryConfig {
            required_token_funding: 0,
            ..valid
        },
        FactoryConfig {
            fee_recipient: Some(ContractAddress::new([0x83; 32])),
            ..valid
        },
    ];

    for (index, invalid_config) in invalid.into_iter().enumerate() {
        let factory = deploy_bare_factory(&env, &factory_hash, 0x90 + index as u8);
        let rejected = env.transact(|tx| {
            tx.call(&ROOT)
                .run(|| StandardTokenFactoryClient::new(&factory).initialize(invalid_config))
        });
        assert_init_error(&rejected, TokenFactoryError::InvalidConfig);

        let accepted = env.transact(|tx| {
            tx.call(&ROOT)
                .run(|| StandardTokenFactoryClient::new(&factory).initialize(valid))
        });
        accepted.assert_success();
        env.advance_block();
    }

    let factory = deploy_bare_factory(&env, &factory_hash, 0xa0);
    env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| StandardTokenFactoryClient::new(&factory).initialize(valid))
    })
    .assert_success();
    env.advance_block();

    let views = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let client = StandardTokenFactoryClient::new(&factory);
            (
                client.config(),
                client.required_token_funding(),
                client.creation_fee(),
            )
        })
    });
    views.assert_success();
    assert_eq!(
        views.assert_return_as::<(FactoryConfig, Amount, Amount)>(),
        (valid, REQUIRED_FUNDING, 0)
    );

    let repeated = env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            StandardTokenFactoryClient::new(&factory).initialize(FactoryConfig {
                token_code_hash: SHA256Hash::new([0; 32]),
                ..valid
            })
        })
    });
    assert_init_error(&repeated, TokenFactoryError::AlreadyInitialized);
}

#[test]
fn identical_same_block_initializations_commit_exactly_once() {
    let env = TestEnvironment::no_cost();
    let factory_hash = *standard_token_factory::register_mock_contract(&env).as_hash();
    let factory = deploy_bare_factory(&env, &factory_hash, 0xa1);
    let config = config(
        SHA256Hash::new([0xa2; 32]),
        ContractAddress::new([0xa3; 32]),
    );
    let mut tx_a = env.transaction().build();
    let mut tx_b = env.transaction().build();

    tx_a.call(&ROOT)
        .run(|| StandardTokenFactoryClient::new(&factory).initialize(config))
        .assert_success();
    tx_b.call(&ADMIN)
        .run(|| StandardTokenFactoryClient::new(&factory).initialize(config))
        .assert_success();

    assert_eq!(tx_a.try_commit_transaction(), TryCommitResult::Ok);
    assert!(matches!(
        tx_b.try_commit_transaction(),
        TryCommitResult::TxNonDeterministicError(_)
    ));
    drop(tx_a);
    drop(tx_b);
    env.advance_block();

    let stored = env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| StandardTokenFactoryClient::new(&factory).config())
    });
    stored.assert_success();
    assert_eq!(stored.assert_return_as::<FactoryConfig>(), config);
}

#[test]
fn prediction_uses_factory_wallet_nonce_and_configured_hash() {
    let setup = setup();
    let predicted = predict(&setup, &setup.wallet, &TOKEN_NONCE);
    let expected = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            predicted_token(
                &setup.factory,
                &setup.wallet,
                &TOKEN_NONCE,
                &setup.token_hash,
            )
        })
    });
    expected.assert_success();
    assert_eq!(predicted, expected.assert_return_as::<ContractAddress>());

    let second_wallet = setup.env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| deploy_contract(&SECOND_WALLET_NONCE, &setup.wallet_hash))
    });
    second_wallet.assert_success();
    let second_wallet = second_wallet.assert_return_as();
    setup.env.advance_block();

    assert_ne!(predicted, predict(&setup, &second_wallet, &TOKEN_NONCE));
    assert_ne!(
        predicted,
        predict(&setup, &setup.wallet, &SECOND_TOKEN_NONCE)
    );
}

#[test]
fn token_validation_and_funding_fail_before_deployment_and_can_be_retried() {
    let setup = setup();

    for (administrator, holder, supply) in [
        (*CONTRACT_ADDR_ZERO, HOLDER, 1),
        (ADMIN, *CONTRACT_ADDR_ZERO, 1),
        (ADMIN, HOLDER, i128::MAX as u128 + 1),
    ] {
        let rejected = create(
            &setup,
            &setup.wallet,
            &TOKEN_NONCE,
            &administrator,
            None,
            None,
            None,
            &holder,
            supply,
        );
        assert_factory_error(&rejected, TokenFactoryError::InvalidTokenConfig);
    }

    let predicted = predict(&setup, &setup.wallet, &TOKEN_NONCE);
    fund(&setup, &setup.wallet, &predicted, REQUIRED_FUNDING - 1);
    let underfunded = create(
        &setup,
        &setup.wallet,
        &TOKEN_NONCE,
        &ADMIN,
        None,
        None,
        None,
        &HOLDER,
        1,
    );
    assert_factory_error(&underfunded, TokenFactoryError::InsufficientTokenFunding);

    fund(&setup, &setup.wallet, &predicted, 1);
    let retried = create(
        &setup,
        &setup.wallet,
        &TOKEN_NONCE,
        &ADMIN,
        None,
        None,
        None,
        &HOLDER,
        1,
    );
    retried.assert_success();
    assert_eq!(retried.assert_return_as::<ContractAddress>(), predicted);
}

#[test]
fn maximum_signed_supply_is_accepted_through_the_factory() {
    let setup = setup();
    let predicted = predict(&setup, &setup.wallet, &MAX_SUPPLY_NONCE);
    fund(&setup, &setup.wallet, &predicted, REQUIRED_FUNDING);

    let created = create(
        &setup,
        &setup.wallet,
        &MAX_SUPPLY_NONCE,
        &ADMIN,
        None,
        None,
        None,
        &HOLDER,
        i128::MAX as u128,
    );
    created.assert_success();
    assert_eq!(created.assert_return_as::<ContractAddress>(), predicted);
    setup.env.advance_block();

    let supply = setup.env.transact(|tx| {
        tx.call(&ROOT)
            .run(|| ERC20Client::new(&predicted).total_supply())
    });
    supply.assert_success();
    assert_eq!(supply.assert_return_as::<Amount>(), i128::MAX as u128);
}

#[test]
fn nonzero_supply_creation_emits_exact_discovery_and_supports_full_lifecycle() {
    let setup = setup();
    let predicted = predict(&setup, &setup.wallet, &TOKEN_NONCE);
    fund(&setup, &setup.wallet, &predicted, REQUIRED_FUNDING);
    let name_text = "N".repeat(100);
    let symbol_text = "S".repeat(10);
    let name: Name = name_text.as_str().try_into().unwrap();
    let symbol: Symbol = symbol_text.as_str().try_into().unwrap();

    let created = create(
        &setup,
        &setup.wallet,
        &TOKEN_NONCE,
        &ADMIN,
        Some(name.clone()),
        Some(symbol.clone()),
        Some(u32::MAX),
        &HOLDER,
        1_000,
    );
    created.assert_success();
    created.assert_event_count(2);
    assert_eq!(created.assert_return_as::<ContractAddress>(), predicted);
    assert!(created.events_from(&setup.native_token).is_empty());
    created.assert_event::<TransferEvent<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), CONTRACT_ADDR_ZERO.as_ref());
        assert_eq!(event.topic(2).unwrap(), HOLDER.as_ref());
        assert_eq!(event.payload().amount, 1_000);
    });
    assert_eq!(
        created.filter_events::<TransferEvent<'_>>(&predicted).len(),
        1
    );
    created.assert_event::<TokenCreated>(1, |event| {
        assert_eq!(event.topic(0).unwrap(), TokenCreated::SIGNATURE);
        assert_eq!(event.topic(1).unwrap(), predicted.as_ref());
        assert_eq!(event.topic(2).unwrap(), setup.wallet.as_ref());
        assert_eq!(event.payload().administrator, ADMIN);
        assert_eq!(event.payload().initial_holder, HOLDER);
        assert_eq!(event.payload().initial_supply, 1_000);
        assert_eq!(event.payload().name, Some(name.clone()));
        assert_eq!(event.payload().symbol, Some(symbol.clone()));
        assert_eq!(event.payload().decimals, Some(u32::MAX));
        assert_eq!(event.payload().token_code_hash, setup.token_hash);
    });
    assert_eq!(
        created.filter_events::<TokenCreated>(&setup.factory).len(),
        1
    );
    setup.env.advance_block();

    let initial_state = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let token = ERC20Client::new(&predicted);
            let metadata = ERC20MetadataClient::new(&predicted);
            (
                token.get_balance_of(&HOLDER),
                token.total_supply(),
                metadata.name(),
                metadata.symbol(),
                metadata.decimals(),
                ERC20Client::new(&setup.native_token).allowance(&setup.wallet, &setup.factory),
            )
        })
    });
    initial_state.assert_success();
    assert_eq!(
        initial_state.assert_return_as::<(
            Amount,
            Amount,
            Option<Name>,
            Option<Symbol>,
            Option<u32>,
            Amount,
        )>(),
        (1_000, 1_000, Some(name), Some(symbol), Some(u32::MAX), 0)
    );

    let unauthorized = setup.env.transact(|tx| {
        tx.call(&setup.factory)
            .run(|| ERC20Client::new(&predicted).mint(&setup.factory, 1))
    });
    assert_erc20_error(&unauthorized, ERC20Error::MustBeContractOwner);

    for (caller, operation) in [
        (ADMIN, 0_u8),
        (HOLDER, 1),
        (HOLDER, 2),
        (SPENDER, 3),
        (ADMIN, 4),
    ] {
        let result = setup.env.transact(|tx| {
            tx.call(&caller).run(|| {
                let token = ERC20Client::new(&predicted);
                match operation {
                    0 => token.mint(&HOLDER, 100),
                    1 => token.transfer(&RECEIVER, 200),
                    2 => token.adjust_allowance(&SPENDER, 150),
                    3 => token.transfer_from(&HOLDER, &RECEIVER, 75),
                    4 => token.burn(&RECEIVER, 25),
                    _ => unreachable!(),
                }
            })
        });
        result.assert_success();
        setup.env.advance_block();
    }

    let final_state = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            let token = ERC20Client::new(&predicted);
            (
                token.get_balance_of(&HOLDER),
                token.get_balance_of(&RECEIVER),
                token.allowance(&HOLDER, &SPENDER),
                token.total_supply(),
            )
        })
    });
    final_state.assert_success();
    assert_eq!(
        final_state.assert_return_as::<(Amount, Amount, Amount, Amount)>(),
        (825, 250, 75, 1_075)
    );
}

#[test]
fn zero_supply_creation_accepts_excess_funding_and_emits_only_discovery() {
    let setup = setup();
    let predicted = predict(&setup, &setup.wallet, &SECOND_TOKEN_NONCE);
    fund(&setup, &setup.wallet, &predicted, REQUIRED_FUNDING + 50);

    let created = create(
        &setup,
        &setup.wallet,
        &SECOND_TOKEN_NONCE,
        &ADMIN,
        None,
        None,
        None,
        &HOLDER,
        0,
    );
    created.assert_success();
    created.assert_event_count(1);
    assert_eq!(created.assert_return_as::<ContractAddress>(), predicted);
    assert!(
        created
            .filter_events::<TransferEvent<'_>>(&predicted)
            .is_empty()
    );
    let discovery = created.filter_events::<TokenCreated>(&setup.factory);
    assert_eq!(discovery.len(), 1);
    assert_eq!(discovery[0].topic(0).unwrap(), TokenCreated::SIGNATURE);
    assert_eq!(discovery[0].topic(1).unwrap(), predicted.as_ref());
    assert_eq!(discovery[0].topic(2).unwrap(), setup.wallet.as_ref());
    assert_eq!(discovery[0].payload().administrator, ADMIN);
    assert_eq!(discovery[0].payload().initial_holder, HOLDER);
    assert_eq!(discovery[0].payload().initial_supply, 0);
    assert_eq!(discovery[0].payload().name, None);
    assert_eq!(discovery[0].payload().symbol, None);
    assert_eq!(discovery[0].payload().decimals, None);
    assert_eq!(discovery[0].payload().token_code_hash, setup.token_hash);
    setup.env.advance_block();

    let state = setup.env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            (
                ERC20Client::new(&predicted).get_balance_of(&HOLDER),
                ERC20Client::new(&predicted).total_supply(),
                ERC20Client::new(&setup.native_token).get_balance_of(&predicted),
            )
        })
    });
    state.assert_success();
    assert_eq!(
        state.assert_return_as::<(Amount, Amount, Amount)>(),
        (0, 0, REQUIRED_FUNDING + 50)
    );
    assert_eq!(setup.config.creation_fee, 0);
}
