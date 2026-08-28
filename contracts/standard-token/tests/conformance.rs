use groundhog_xdr::storage_item::WireStorageItem;
use sdk::call::RawCallError;
use sdk::*;
use standard_token::*;

const DEPLOYER: ContractAddress = ContractAddress::new([0x10; 32]);
const ADMIN: ContractAddress = ContractAddress::new([0x20; 32]);
const HOLDER: ContractAddress = ContractAddress::new([0x30; 32]);
const RECEIVER: ContractAddress = ContractAddress::new([0x40; 32]);
const SPENDER: ContractAddress = ContractAddress::new([0x50; 32]);
const OUTSIDER: ContractAddress = ContractAddress::new([0x60; 32]);

fn setup() -> (TestEnvironmentHandle, ContractAddress) {
    let env = TestEnvironment::no_cost();
    let hash = *register_mock_contract(&env).as_hash();
    let deployed = env.transact(|tx| {
        tx.call(&DEPLOYER)
            .run(|| deploy_contract(&SHA256Hash::new([0x77; 32]), &hash))
    });
    deployed.assert_success();
    let address = deployed.assert_return_as();
    env.advance_block();
    (env, address)
}

fn name(value: &str) -> Name {
    value.try_into().unwrap()
}

fn symbol(value: &str) -> Symbol {
    value.try_into().unwrap()
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

fn commit(env: &TestEnvironmentHandle, result: TransactResult) {
    result.assert_success();
    env.advance_block();
}

#[expect(
    clippy::too_many_arguments,
    reason = "the helper mirrors the fixed factory initializer ABI"
)]
fn factory_initialize(
    env: &TestEnvironmentHandle,
    token: &ContractAddress,
    caller: &ContractAddress,
    administrator: &ContractAddress,
    token_name: Option<Name>,
    token_symbol: Option<Symbol>,
    decimals: Option<u32>,
    holder: &ContractAddress,
    supply: Amount,
) -> TransactResult {
    env.transact(|tx| {
        tx.call(caller).run(|| {
            StandardTokenInitializerClient::new(token).initialize_from_factory(
                administrator,
                token_name,
                token_symbol,
                decimals,
                holder,
                supply,
            );
        })
    })
}

#[test]
fn regular_erc20_lifecycle_preserves_balances_supply_allowances_and_authority() {
    let (env, token) = setup();

    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).initialize(&ADMIN))
        }),
    );
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).mint(&ADMIN, 1_000))
        }),
    );
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).transfer(&RECEIVER, 250))
        }),
    );
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).adjust_allowance(&SPENDER, 200))
        }),
    );
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&SPENDER)
                .run(|| ERC20Client::new(&token).transfer_from(&ADMIN, &HOLDER, 125))
        }),
    );
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).burn(&RECEIVER, 50))
        }),
    );

    let state = env.transact(|tx| {
        tx.call(&ADMIN).run(|| {
            let client = ERC20Client::new(&token);
            (
                client.get_balance(),
                client.get_balance_of(&RECEIVER),
                client.get_balance_of(&HOLDER),
                client.allowance(&ADMIN, &SPENDER),
                client.total_supply(),
            )
        })
    });
    state.assert_success();
    assert_eq!(
        state.assert_return_as::<(u128, u128, u128, u128, u128)>(),
        (625, 200, 125, 75, 950)
    );

    let unauthorized_mint = env.transact(|tx| {
        tx.call(&OUTSIDER)
            .run(|| ERC20Client::new(&token).mint(&OUTSIDER, 1))
    });
    assert_erc20_error(&unauthorized_mint, ERC20Error::MustBeContractOwner);
    let unauthorized_burn = env.transact(|tx| {
        tx.call(&OUTSIDER)
            .run(|| ERC20Client::new(&token).burn(&ADMIN, 1))
    });
    assert_erc20_error(&unauthorized_burn, ERC20Error::MustBeContractOwner);
}

#[test]
fn mint_overflow_throws_too_large_before_state_or_events() {
    let (env, token) = setup();
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).initialize(&ADMIN))
        }),
    );
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).mint(&ADMIN, i128::MAX as u128))
        }),
    );

    let overflow = env.transact(|tx| {
        tx.call(&ADMIN)
            .run(|| ERC20Client::new(&token).mint(&RECEIVER, 1))
    });
    assert_erc20_error(&overflow, ERC20Error::TooLarge);

    let state = env.transact(|tx| {
        tx.call(&OUTSIDER).run(|| {
            let client = ERC20Client::new(&token);
            (
                client.get_balance_of(&ADMIN),
                client.get_balance_of(&RECEIVER),
                client.total_supply(),
            )
        })
    });
    assert_eq!(
        state.assert_return_as::<(u128, u128, u128)>(),
        (i128::MAX as u128, 0, i128::MAX as u128)
    );
}

#[test]
fn overdrafts_and_allowance_overflow_throw_without_events() {
    let (env, token) = setup();
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).initialize(&ADMIN))
        }),
    );

    let transfer = env.transact(|tx| {
        tx.call(&ADMIN)
            .run(|| ERC20Client::new(&token).transfer(&RECEIVER, 1))
    });
    assert_erc20_error(&transfer, ERC20Error::TooLarge);

    let delegated = env.transact(|tx| {
        tx.call(&SPENDER)
            .run(|| ERC20Client::new(&token).transfer_from(&ADMIN, &RECEIVER, 1))
    });
    assert_erc20_error(&delegated, ERC20Error::TooLarge);

    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).adjust_allowance(&SPENDER, i128::MAX))
        }),
    );
    let allowance_overflow = env.transact(|tx| {
        tx.call(&ADMIN)
            .run(|| ERC20Client::new(&token).adjust_allowance(&SPENDER, 1))
    });
    assert_erc20_error(&allowance_overflow, ERC20Error::TooLarge);

    let allowance = env.transact(|tx| {
        tx.call(&OUTSIDER)
            .run(|| ERC20Client::new(&token).allowance(&ADMIN, &SPENDER))
    });
    assert_eq!(allowance.assert_return_as::<u128>(), i128::MAX as u128);
}

#[test]
fn zero_operations_emit_canonical_transfer_and_approval_events() {
    let (env, token) = setup();
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).initialize(&ADMIN))
        }),
    );

    let transfer = env.transact(|tx| {
        tx.call(&ADMIN)
            .run(|| ERC20Client::new(&token).transfer(&RECEIVER, 0))
    });
    transfer.assert_success();
    transfer.assert_event_count(1);
    transfer.assert_event::<TransferEvent<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ADMIN.as_ref());
        assert_eq!(event.topic(2).unwrap(), RECEIVER.as_ref());
        assert_eq!(event.payload().amount, 0);
    });

    let approval = env.transact(|tx| {
        tx.call(&ADMIN)
            .run(|| ERC20Client::new(&token).adjust_allowance(&SPENDER, 0))
    });
    approval.assert_success();
    approval.assert_event_count(1);
    approval.assert_event::<ApprovalEvent<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ADMIN.as_ref());
        assert_eq!(event.topic(2).unwrap(), SPENDER.as_ref());
        assert_eq!(event.payload().difference, 0);
    });
}

#[test]
fn metadata_initializer_sets_views() {
    let (env, token) = setup();
    let result = env.transact(|tx| {
        tx.call(&ADMIN).run(|| {
            ERC20MetadataClient::new(&token).initialize(
                &ADMIN,
                Some(name("Groundhog Token")),
                Some(symbol("HOG")),
                Some(9),
            )
        })
    });
    result.assert_success();
    env.advance_block();

    let views = env.transact(|tx| {
        tx.call(&OUTSIDER).run(|| {
            let client = ERC20MetadataClient::new(&token);
            (client.name(), client.symbol(), client.decimals())
        })
    });
    views.assert_success();
    assert_eq!(
        views.assert_return_as::<(Option<Name>, Option<Symbol>, Option<u32>)>(),
        (Some(name("Groundhog Token")), Some(symbol("HOG")), Some(9))
    );
}

#[test]
fn factory_initializer_accepts_none_short_and_maximum_metadata() {
    let cases = [
        (None, None, None),
        (Some(name("T")), Some(symbol("T")), Some(0)),
        (
            Some(name(&"N".repeat(100))),
            Some(symbol(&"S".repeat(10))),
            Some(u32::MAX),
        ),
    ];

    for (token_name, token_symbol, decimals) in cases {
        let (env, token) = setup();
        let result = factory_initialize(
            &env,
            &token,
            &DEPLOYER,
            &ADMIN,
            token_name.clone(),
            token_symbol.clone(),
            decimals,
            &HOLDER,
            321,
        );
        result.assert_success();
        env.advance_block();

        let views = env.transact(|tx| {
            tx.call(&OUTSIDER).run(|| {
                let erc20 = ERC20Client::new(&token);
                let metadata = ERC20MetadataClient::new(&token);
                (
                    erc20.get_balance_of(&HOLDER),
                    erc20.total_supply(),
                    metadata.name(),
                    metadata.symbol(),
                    metadata.decimals(),
                )
            })
        });
        views.assert_success();
        assert_eq!(
            views.assert_return_as::<(u128, u128, Option<Name>, Option<Symbol>, Option<u32>)>(),
            (321, 321, token_name, token_symbol, decimals)
        );
    }
}

#[test]
fn zero_factory_supply_materializes_a_zero_nnint_holder_row() {
    let (env, token) = setup();
    let result = factory_initialize(
        &env, &token, &DEPLOYER, &ADMIN, None, None, None, &HOLDER, 0,
    );
    result.assert_success();
    result.assert_no_events();
    env.advance_block();

    let key_result = env.transact(|tx| tx.call(&token).run(|| balance_storage_key(&HOLDER)));
    key_result.assert_success();
    let key = key_result.assert_return_as();
    match env.get_snapshot_storage_item(&token, &key) {
        Some(WireStorageItem::kItemTypeNonnegativeInt { nnint }) => {
            assert_eq!(i128::from(nnint), 0);
        }
        other => panic!("expected physical zero NNInt holder row, got {other:?}"),
    }
}

#[test]
fn factory_supply_bound_accepts_max_and_rejects_max_plus_one_before_writes() {
    let max = i128::MAX as u128;
    let (env, token) = setup();
    let accepted = factory_initialize(
        &env, &token, &DEPLOYER, &ADMIN, None, None, None, &HOLDER, max,
    );
    accepted.assert_success();
    accepted.assert_event_count(1);
    env.advance_block();
    let state = env.transact(|tx| {
        tx.call(&OUTSIDER).run(|| {
            let client = ERC20Client::new(&token);
            (client.get_balance_of(&HOLDER), client.total_supply())
        })
    });
    assert_eq!(state.assert_return_as::<(u128, u128)>(), (max, max));

    let (env, token) = setup();
    let rejected = factory_initialize(
        &env,
        &token,
        &DEPLOYER,
        &ADMIN,
        Some(name("must rollback")),
        None,
        None,
        &HOLDER,
        max + 1,
    );
    assert_erc20_error(&rejected, ERC20Error::TooLarge);
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).initialize(&ADMIN))
        }),
    );
}

#[test]
fn factory_initializer_rejects_zero_administrator_and_holder_before_writes() {
    for (administrator, holder) in [(*CONTRACT_ADDR_ZERO, HOLDER), (ADMIN, *CONTRACT_ADDR_ZERO)] {
        let (env, token) = setup();
        let result = factory_initialize(
            &env,
            &token,
            &DEPLOYER,
            &administrator,
            None,
            None,
            None,
            &holder,
            1,
        );
        assert_erc20_error(&result, ERC20Error::TooLarge);
        commit(
            &env,
            env.transact(|tx| {
                tx.call(&ADMIN)
                    .run(|| ERC20Client::new(&token).initialize(&ADMIN))
            }),
        );
    }
}

#[test]
fn all_initializer_entrypoints_share_the_already_initialized_guard() {
    let (env, token) = setup();
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).initialize(&ADMIN))
        }),
    );

    let metadata = env.transact(|tx| {
        tx.call(&ADMIN).run(|| {
            ERC20MetadataClient::new(&token).initialize(&ADMIN, Some(name("second")), None, None)
        })
    });
    assert_erc20_error(&metadata, ERC20Error::AlreadyInitialized);
    let factory = factory_initialize(
        &env, &token, &DEPLOYER, &ADMIN, None, None, None, &HOLDER, 1,
    );
    assert_erc20_error(&factory, ERC20Error::AlreadyInitialized);
    let regular = env.transact(|tx| {
        tx.call(&ADMIN)
            .run(|| ERC20Client::new(&token).initialize(&ADMIN))
    });
    assert_erc20_error(&regular, ERC20Error::AlreadyInitialized);
}

#[test]
fn identical_same_block_factory_initializations_commit_exactly_once() {
    let (env, token) = setup();
    let mut tx_a = env.transaction().build();
    let mut tx_b = env.transaction().build();
    let frame_a = tx_a.call(&DEPLOYER).run(|| {
        StandardTokenInitializerClient::new(&token)
            .initialize_from_factory(&ADMIN, None, None, None, &HOLDER, 500)
    });
    let frame_b = tx_b.call(&DEPLOYER).run(|| {
        StandardTokenInitializerClient::new(&token)
            .initialize_from_factory(&ADMIN, None, None, None, &HOLDER, 500)
    });
    frame_a.assert_event_count(1);
    frame_b.assert_event_count(1);

    assert_eq!(tx_a.try_commit_transaction(), TryCommitResult::Ok);
    assert!(matches!(
        tx_b.try_commit_transaction(),
        TryCommitResult::TxNonDeterministicError(_)
    ));
    drop(tx_a);
    drop(tx_b);
    env.advance_block();

    let state = env.transact(|tx| {
        tx.call(&OUTSIDER).run(|| {
            let client = ERC20Client::new(&token);
            (client.get_balance_of(&HOLDER), client.total_supply())
        })
    });
    state.assert_success();
    assert_eq!(state.assert_return_as::<(u128, u128)>(), (500, 500));
}

#[test]
fn factory_initial_mint_event_is_canonical_and_zero_supply_emits_none() {
    let (env, token) = setup();
    let minted = factory_initialize(
        &env, &token, &DEPLOYER, &ADMIN, None, None, None, &HOLDER, 42,
    );
    minted.assert_success();
    minted.assert_event_count(1);
    minted.assert_event::<TransferEvent<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), CONTRACT_ADDR_ZERO.as_ref());
        assert_eq!(event.topic(2).unwrap(), HOLDER.as_ref());
        assert_eq!(event.payload().amount, 42);
    });

    let (env, token) = setup();
    factory_initialize(
        &env, &token, &DEPLOYER, &ADMIN, None, None, None, &HOLDER, 0,
    )
    .assert_no_events();
}

#[test]
fn factory_caller_has_no_implicit_mint_authority() {
    let (env, token) = setup();
    factory_initialize(
        &env, &token, &DEPLOYER, &ADMIN, None, None, None, &HOLDER, 0,
    )
    .assert_success();
    env.advance_block();

    let caller_mint = env.transact(|tx| {
        tx.call(&DEPLOYER)
            .run(|| ERC20Client::new(&token).mint(&DEPLOYER, 1))
    });
    assert_erc20_error(&caller_mint, ERC20Error::MustBeContractOwner);
    commit(
        &env,
        env.transact(|tx| {
            tx.call(&ADMIN)
                .run(|| ERC20Client::new(&token).mint(&ADMIN, 1))
        }),
    );
}

#[test]
fn erc20_identity_comes_from_the_pinned_interface_crates() {
    assert_eq!(ERC20Client::INTERFACE_VERSION, "0.1.9");
    assert_eq!(ERC20MetadataClient::INTERFACE_VERSION, "0.1.9");
    assert_eq!(
        TransferEvent::SIGNATURE,
        groundhog_erc20_if::TransferEvent::SIGNATURE
    );
    let amount: Amount = i128::MAX as u128;
    let difference: Difference = amount as i128;
    assert_eq!(difference, i128::MAX);
    assert_eq!(
        ERC20Error::TooLarge,
        groundhog_erc20_if::ERC20Error::TooLarge
    );
}
