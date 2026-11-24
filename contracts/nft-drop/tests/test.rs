//! Native tests for one drop: minting, the supply cap under same-block
//! concurrency, validation, and the ERC721 surface.
//!
//! `env.transact` runs one transaction. Transactions before
//! `env.advance_block()` share a block: each reads the previous block's
//! state, and their writes merge when the block closes.

use std::collections::HashSet;

use nft_drop::*;
use thruput_erc165_if::ERC165Client;
use thruput_erc721_if::{ERC721Entrypoints, ERC721MetadataEntrypoints, OnchainMetadata};
use thruput_sdk::call::RawCallError;
use thruput_sdk::*;

fn drop_address() -> ContractAddress {
    ContractAddress::named("drop")
}
fn creator() -> ContractAddress {
    ContractAddress::named("creator")
}
fn user(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn value(name: &str, weight: u32) -> TraitValue {
    TraitValue {
        name: name.try_into().unwrap(),
        weight,
    }
}

fn definition(supply: u32) -> DropDefinition {
    DropDefinition {
        name: "Critters".try_into().unwrap(),
        symbol: "CRIT".try_into().unwrap(),
        supply,
        traits: VecM(vec![
            Trait {
                name: "Background".try_into().unwrap(),
                values: VecM(vec![
                    value("Sky", 60),
                    value("Sunset", 30),
                    value("Gold", 10),
                ]),
            },
            Trait {
                name: "Body".try_into().unwrap(),
                values: VecM(vec![value("Round", 50), value("Square", 50)]),
            },
        ]),
    }
}

fn try_setup(definition: DropDefinition) -> (TestEnvironmentHandle, TransactResult) {
    let env = TestEnvironment::no_cost();
    nft_drop::register_mock_contract(&env).deploy_contract_to(&drop_address());
    let result = env.transact(|tx| {
        tx.call(&creator())
            .run(move || NftDropClient::new(&drop_address()).initialize(&creator(), definition))
    });
    (env, result)
}

/// A drop initialized in a committed block, so minting is open.
fn setup(supply: u32) -> TestEnvironmentHandle {
    let (env, result) = try_setup(definition(supply));
    result.assert_success();
    env.advance_block();
    env
}

fn mint(env: &TestEnvironmentHandle, who: &str) -> TransactResult {
    let caller = user(who);
    env.transact(|tx| {
        tx.call(&caller)
            .run(|| NftDropClient::new(&drop_address()).mint())
    })
}

/// Run `read` as a view-like transaction and return its result.
fn read<T: ReadXDROwned + WriteXDR + 'static>(
    env: &TestEnvironmentHandle,
    read: impl FnOnce() -> T + std::panic::UnwindSafe + 'static,
) -> T {
    let result = env.transact(|tx| tx.call(&user("reader")).run(read));
    result.assert_success();
    result.assert_return_as::<T>()
}

#[track_caller]
fn assert_drop_error(result: &TransactResult, expected: DropError) {
    result.assert_abort();
    match into_root_call_result::<TokenId>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<DropError>(), Some(expected));
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

#[test]
fn a_mint_records_the_owner_traits_and_counts() {
    let env = setup(10);
    let result = mint(&env, "alice");
    result.assert_success();
    let token_id = result.assert_return_as::<TokenId>();
    env.advance_block();

    let drop = || NftDropClient::new(&drop_address());
    assert_eq!(
        read(&env, move || ERC721Client::new(&drop_address())
            .owner_of(&token_id)),
        user("alice")
    );
    assert_eq!(
        read(&env, || ERC721Client::new(&drop_address())
            .balance_of(&user("alice"))),
        1
    );
    assert_eq!(read(&env, move || drop().remaining()), 9);

    let traits = read(&env, move || drop().traits_of(&token_id));
    assert_eq!(traits.len(), 2);
    let (background, body) = (u32::from(traits[0]), u32::from(traits[1]));
    assert_eq!(read(&env, move || drop().trait_count(0, background)), 1);
    assert_eq!(read(&env, move || drop().trait_count(1, body)), 1);

    // On-chain metadata names the token and lists its traits.
    let metadata = read(&env, move || {
        ERC721MetadataClient::new(&drop_address()).token_metadata(&token_id)
    });
    let TokenMetadata::Onchain(OnchainMetadata {
        name, description, ..
    }) = metadata
    else {
        panic!("expected on-chain metadata");
    };
    assert!(name.starts_with("Critters #"), "{name}");
    assert!(description.starts_with("Background: "), "{description}");
    assert!(description.contains(", Body: "), "{description}");
}

// The claim the app demonstrates: mints in one block do not conflict. Every
// mint decreases `remaining` and increases the same trait counters, and all
// of those deltas merge.
#[test]
fn a_hundred_mints_in_one_block_all_land() {
    let env = setup(100);
    for i in 0..100 {
        mint(&env, &format!("minter-{i}")).assert_success();
    }
    env.advance_block();

    let drop = || NftDropClient::new(&drop_address());
    assert_eq!(read(&env, move || drop().remaining()), 0);
    let background: u32 = (0..3)
        .map(|v| read(&env, move || drop().trait_count(0, v)))
        .sum();
    let body: u32 = (0..2)
        .map(|v| read(&env, move || drop().trait_count(1, v)))
        .sum();
    assert_eq!((background, body), (100, 100));
}

// Each mint checks `remaining` against the block's starting value, so the
// 101st mint also executes. The runtime then admits only as many decreases as
// that value covers, and excludes the one that would oversell. In a later
// block, the check itself fails.
#[test]
fn the_supply_cap_excludes_the_mint_that_would_oversell() {
    let env = setup(100);
    for i in 0..100 {
        mint(&env, &format!("minter-{i}")).assert_success();
    }
    mint(&env, "one-too-many").assert_commit_failed_nondeterministically();
    env.advance_block();

    assert_eq!(
        read(&env, || NftDropClient::new(&drop_address()).remaining()),
        0
    );
    assert_drop_error(&mint(&env, "late"), DropError::SoldOut);
}

#[test]
fn token_ids_are_unique_in_one_block_and_in_one_transaction() {
    let env = setup(10);
    let mut ids = HashSet::new();
    for who in ["alice", "bob", "carol"] {
        ids.insert(mint(&env, who).assert_return_as::<TokenId>());
    }
    // Two mints in one transaction share its hash; the counter separates them.
    let both = env.transact(|tx| {
        tx.call(&user("dave")).run(|| {
            let drop = NftDropClient::new(&drop_address());
            (drop.mint(), drop.mint())
        })
    });
    let (first, second) = both.assert_return_as::<(TokenId, TokenId)>();
    ids.extend([first, second]);
    assert_eq!(ids.len(), 5);
    env.advance_block();

    assert_eq!(
        read(&env, || ERC721Client::new(&drop_address())
            .balance_of(&user("dave"))),
        2
    );
}

#[test]
fn minting_opens_in_the_block_after_initialization() {
    let (env, result) = try_setup(definition(10));
    result.assert_success();
    // The drop's configuration is not in this block's snapshot yet.
    mint(&env, "early").assert_abort();
    env.advance_block();
    mint(&env, "on-time").assert_success();
}

#[test]
fn initialization_rejects_invalid_definitions() {
    let label = |text: &str| -> Label { text.try_into().unwrap() };
    type Change = fn(&mut DropDefinition);
    let cases: Vec<(&str, Change)> = vec![
        ("zero supply", |d| d.supply = 0),
        ("supply above 10,000", |d| d.supply = MAX_SUPPLY + 1),
        ("blank name", |d| d.name = " ".try_into().unwrap()),
        ("blank symbol", |d| d.symbol = "".try_into().unwrap()),
        ("no traits", |d| d.traits = VecM(vec![])),
        ("one value", |d| {
            d.traits.0[0].values = VecM(vec![value("Only", 1)])
        }),
        ("zero weight", |d| d.traits.0[0].values.0[0].weight = 0),
        ("weight above 10,000", |d| {
            d.traits.0[0].values.0[0].weight = MAX_WEIGHT + 1
        }),
        ("duplicate value", |d| {
            d.traits.0[1].values.0[1].name = "Round".try_into().unwrap()
        }),
    ];
    for (case, change) in cases {
        let mut invalid = definition(10);
        change(&mut invalid);
        let (_env, result) = try_setup(invalid);
        result.assert_abort();
        match into_root_call_result::<()>(&result) {
            Err(RawCallError::Exception(error)) => assert_eq!(
                error.try_as::<DropError>(),
                Some(DropError::InvalidDefinition),
                "{case}"
            ),
            other => panic!("{case}: expected InvalidDefinition, got {other:?}"),
        }
    }

    let mut duplicate_trait = definition(10);
    duplicate_trait.traits.0[1].name = label("Background");
    try_setup(duplicate_trait).1.assert_abort();

    // A valid drop cannot be initialized twice.
    let env = setup(10);
    let again = env.transact(|tx| {
        tx.call(&user("mallory"))
            .run(|| NftDropClient::new(&drop_address()).initialize(&user("mallory"), definition(5)))
    });
    again.assert_abort();
}

#[test]
fn owners_and_approved_addresses_can_transfer() {
    let env = setup(10);
    let token_id = mint(&env, "alice").assert_return_as::<TokenId>();
    env.advance_block();

    let transfer = |who: &str, from: &str, to: &str| {
        let (caller, from, to) = (user(who), user(from), user(to));
        env.transact(|tx| {
            tx.call(&caller).run(move || {
                ERC721Client::new(&drop_address()).transfer_from(&from, &to, &token_id)
            })
        })
    };

    // A stranger cannot move Alice's token.
    transfer("mallory", "alice", "mallory").assert_abort();

    // Alice approves Bob, and Bob moves the token to Carol.
    env.transact(|tx| {
        tx.call(&user("alice"))
            .run(move || ERC721Client::new(&drop_address()).approve(&user("bob"), &token_id))
    })
    .assert_success();
    env.advance_block();
    transfer("bob", "alice", "carol").assert_success();
    env.advance_block();

    let token = || ERC721Client::new(&drop_address());
    assert_eq!(
        read(&env, move || token().owner_of(&token_id)),
        user("carol")
    );
    assert_eq!(read(&env, move || token().balance_of(&user("alice"))), 0);
    assert_eq!(read(&env, move || token().balance_of(&user("carol"))), 1);
    // The transfer cleared Bob's approval.
    assert_eq!(
        read(&env, move || token().get_approved(&token_id)),
        *thruput_erc721_if::CONTRACT_ADDR_ZERO
    );
}

// Both transfers read a snapshot in which Alice owns the token. The exclusive
// write to the owner key lets only one of them land.
#[test]
fn two_transfers_of_one_token_in_a_block_land_once() {
    let env = setup(10);
    let token_id = mint(&env, "alice").assert_return_as::<TokenId>();
    env.advance_block();

    let send = |to: &str| {
        let to = user(to);
        env.transact(|tx| {
            tx.call(&user("alice")).run(move || {
                ERC721Client::new(&drop_address()).transfer_from(&user("alice"), &to, &token_id)
            })
        })
    };
    send("bob").assert_success();
    send("carol").assert_commit_failed_nondeterministically();
    env.advance_block();

    assert_eq!(
        read(&env, move || ERC721Client::new(&drop_address())
            .owner_of(&token_id)),
        user("bob")
    );
}

#[test]
fn erc165_reports_the_token_interfaces() {
    let env = setup(10);
    let answers = read(&env, || {
        let erc165 = ERC165Client::new(&drop_address());
        (
            erc165.supports_interface(ERC721Entrypoints::INTERFACE_ID),
            erc165.supports_interface(ERC721MetadataEntrypoints::INTERFACE_ID),
        )
    });
    assert_eq!(answers, (true, true));
}
