//! Real-artifact token factory lifecycle on a fresh `hog-devnode`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use standard_token::ClawbackEvent;
use standard_token::Config;
use standard_token_factory::{FactoryConfig, TokenCreated, TokenFactoryError};
use thruput_erc20_if::{AllowanceChangeEvent, BurnEvent, MintEvent, TransferEvent};
use thruput_json_rpc_types::base58::Base58;
use thruput_json_rpc_types::hex::Topic;
use thruput_json_rpc_types::requests::{
    AscendingAnchor, EventFilter, EventQuery, HistoryStart, TopicFilter as EventTopics,
};
use thruput_json_rpc_types::responses::{
    IdentifiedEvent, ReceiptExecution as ExecutionResult, TransactionReceipt,
};
use thruput_sdk::Event as _;
use thruput_sdk::exn::{LibraryExn, RawException};
use thruput_testkit::xdr::types::{ContractAddress, SHA256Hash};
use thruput_testkit::{
    Agent, AgentContext, Caller, DeployOptions, LocalNetworkConfig, NetworkConfig, Result,
    Scenario, xdrs,
};

type ERC20Remote = thruput_erc20_if::ERC20Remote<Caller>;
type ERC20MetadataRemote = thruput_erc20_metadata_if::ERC20MetadataRemote<Caller>;
type ERC20ClawbackRemote = thruput_erc20_controls_if::ERC20ClawbackRemote<Caller>;
type StandardTokenFactoryRemote = standard_token_factory_if::StandardTokenFactoryRemote<Caller>;

const ERC20: (&str, &str) = ("ERC20", "0.1.70");
const METADATA: (&str, &str) = ("ERC20Metadata", "0.1.70");
const FACTORY: (&str, &str) = ("StandardTokenFactory", "0.1.0");
const REQUIRED_FACTORY_FUNDING: i128 = 1_000_000;
// Exactly what creating a token through the factory costs its new address
// under the devnode's default cost model: the deployment (base plus the
// artifact's bytes), the config and holder rows, and the holder's native
// balance item. Pinned to the artifact size, so it moves when the token does.
const REQUIRED_TOKEN_FUNDING: i128 = 363_450;
// What to send the predicted address so that, after its own balance item is
// paid for, exactly `REQUIRED_TOKEN_FUNDING` arrives.
const TOKEN_SOURCE_FUNDING: i128 = 364_684;
const ROW_FUNDING: i128 = 12_000;
const NATIVE_TOKEN_FUNDING: i128 = 1_000_000;
const CREATION_FEE: i128 = 25;

#[derive(Debug, Clone, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "thruput_testkit::xdrs")]
struct SpendRequest {
    token: ContractAddress,
    owner: ContractAddress,
    amount: i128,
}

fn native_token(ctx: &AgentContext) -> ERC20Remote {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    ERC20Remote::new(ctx.caller().clone(), &ContractAddress::from(bytes))
}

fn token(ctx: &AgentContext, address: ContractAddress) -> ERC20Remote {
    ERC20Remote::new(ctx.caller().clone(), &address)
}

fn metadata(ctx: &AgentContext, address: ContractAddress) -> ERC20MetadataRemote {
    ERC20MetadataRemote::new(ctx.caller().clone(), &address)
}

fn maximum_config(administrator: ContractAddress) -> Config {
    Config {
        administrator,
        name: Some("N".repeat(100).as_str().try_into().unwrap()),
        symbol: Some("S".repeat(10).as_str().try_into().unwrap()),
        decimals: Some(u32::MAX),
    }
}

async fn deploy_factory(
    ctx: &mut AgentContext,
    config: FactoryConfig,
) -> Result<StandardTokenFactoryRemote> {
    // The factory pays for its own storage, so the deployment carries its
    // funding.
    let factory = StandardTokenFactoryRemote::new(
        ctx.caller().clone(),
        &ctx.deploy_artifact(
            "standard_token_factory",
            DeployOptions::funded(REQUIRED_FACTORY_FUNDING as u128),
        )
        .await?
        .address,
    );
    factory.initialize(config).await?;
    let stored = factory.config().await?;
    assert_eq!(stored, config);
    Ok(factory)
}

async fn predict(
    ctx: &AgentContext,
    factory: &StandardTokenFactoryRemote,
    nonce: SHA256Hash,
) -> Result<ContractAddress> {
    factory.predict_token(&ctx.address(), &nonce).await
}

async fn create(
    factory: &StandardTokenFactoryRemote,
    nonce: SHA256Hash,
    config: &Config,
    initial_holder: ContractAddress,
    initial_supply: i128,
) -> Result<thruput_testkit::SubmittedContractCall> {
    factory
        .create_token(
            &nonce,
            &config.administrator,
            config.name.clone(),
            config.symbol.clone(),
            config.decimals,
            &initial_holder,
            initial_supply,
        )
        .submit()
        .await
}

async fn balance(contract: &ERC20Remote, owner: ContractAddress) -> Result<i128> {
    contract.get_balance_of(&owner).await
}

async fn reserve(native: &ERC20Remote, address: ContractAddress) -> Result<i128> {
    balance(native, address).await
}

/// A call that aborted inside the account's default wallet. The wallet made
/// the call on the account's behalf and reports the abort as its own
/// `WalletError::CallAborted` (variant 5); the callee's exception, such as the
/// factory's `TokenFactoryError`, is not forwarded through it.
fn assert_wallet_call_aborted(receipt: &TransactionReceipt) {
    let ExecutionResult::Abort { abort_data: abort } = &receipt.execution else {
        panic!("expected reverted factory call: {:?}", receipt.execution);
    };
    let exception = RawException::from_abort_buf(&abort.0).expect("decode the wallet's exception");
    assert!(exception.try_as::<LibraryExn>().is_none());
    assert!(exception.try_as::<TokenFactoryError>().is_none());
    assert_eq!(exception.payload(), [5]);
}

fn assert_transfer(
    receipt: &TransactionReceipt,
    index: usize,
    contract: ContractAddress,
    from: ContractAddress,
    to: ContractAddress,
    amount: i128,
) {
    let event = &receipt.events[index];
    assert_eq!(event.address.0, contract);
    assert_eq!(event.topics.len(), 3);
    assert_eq!(event.topics[0].0, *TransferEvent::SIGNATURE);
    assert_eq!(event.topics[1].0, *from.as_ref());
    assert_eq!(event.topics[2].0, *to.as_ref());
    assert_eq!(xdrs::cxs::decode::<i128>(&event.data.0).unwrap(), amount);
}

fn assert_mint(
    receipt: &TransactionReceipt,
    index: usize,
    contract: ContractAddress,
    to: ContractAddress,
    amount: i128,
) {
    let event = &receipt.events[index];
    assert_eq!(event.address.0, contract);
    assert_eq!(event.topics.len(), 2);
    assert_eq!(event.topics[0].0, *MintEvent::SIGNATURE);
    assert_eq!(event.topics[1].0, *to.as_ref());
    assert_eq!(xdrs::cxs::decode::<i128>(&event.data.0).unwrap(), amount);
}

/// A forced burn: the canonical `BurnEvent`, then the `ClawbackEvent` that
/// records it was the administrator's doing.
fn assert_clawback(
    receipt: &TransactionReceipt,
    index: usize,
    contract: ContractAddress,
    from: ContractAddress,
    amount: i128,
) {
    let burn = &receipt.events[index];
    assert_eq!(burn.address.0, contract);
    assert_eq!(burn.topics.len(), 2);
    assert_eq!(burn.topics[0].0, *BurnEvent::SIGNATURE);
    assert_eq!(burn.topics[1].0, *from.as_ref());
    assert_eq!(xdrs::cxs::decode::<i128>(&burn.data.0).unwrap(), amount);

    let clawback = &receipt.events[index + 1];
    assert_eq!(clawback.address.0, contract);
    assert_eq!(clawback.topics[0].0, *ClawbackEvent::SIGNATURE);
    assert_eq!(clawback.topics[1].0, *from.as_ref());
}

fn assert_allowance_change(
    receipt: &TransactionReceipt,
    index: usize,
    contract: ContractAddress,
    owner: ContractAddress,
    spender: ContractAddress,
    difference: i128,
) {
    let event = &receipt.events[index];
    assert_eq!(event.address.0, contract);
    assert_eq!(event.topics.len(), 3);
    assert_eq!(event.topics[0].0, *AllowanceChangeEvent::SIGNATURE);
    assert_eq!(event.topics[1].0, *owner.as_ref());
    assert_eq!(event.topics[2].0, *spender.as_ref());
    assert_eq!(
        xdrs::cxs::decode::<i128>(&event.data.0).unwrap(),
        difference
    );
}

#[expect(
    clippy::too_many_arguments,
    reason = "the assertion mirrors the fixed TokenCreated event schema"
)]
fn assert_created(
    receipt: &TransactionReceipt,
    factory: ContractAddress,
    token: ContractAddress,
    creator: ContractAddress,
    config: &Config,
    holder: ContractAddress,
    supply: i128,
    token_hash: SHA256Hash,
) {
    assert!(receipt.events.len() >= 2);
    let first_creation_event = receipt.events.len() - 2;
    assert_mint(receipt, first_creation_event, token, holder, supply);

    let event = &receipt.events[first_creation_event + 1];
    assert_eq!(event.address.0, factory);
    assert_eq!(event.topics.len(), 3);
    assert_eq!(event.topics[0].0, *TokenCreated::SIGNATURE);
    assert_eq!(event.topics[1].0, *token.as_ref());
    assert_eq!(event.topics[2].0, *creator.as_ref());
    let payload = TokenCreated::decode_payload(&event.data.0).expect("decode TokenCreated payload");
    assert_eq!(payload.administrator, config.administrator);
    assert_eq!(payload.initial_holder, holder);
    assert_eq!(payload.initial_supply, supply);
    assert_eq!(payload.name, config.name);
    assert_eq!(payload.symbol, config.symbol);
    assert_eq!(payload.decimals, config.decimals);
    assert_eq!(payload.token_code_hash, token_hash);
}

fn event_query(
    factory: ContractAddress,
    height: thruput_json_rpc_types::BlockHeight,
) -> EventQuery {
    EventQuery {
        filters: vec![EventFilter {
            addresses: vec![Base58(factory)],
            topics: Some(EventTopics {
                topic0: Some(vec![Topic(*TokenCreated::SIGNATURE)]),
                topic1: None,
                topic2: None,
            }),
        }],
        start: Some(HistoryStart::Ascending {
            anchor: AscendingAnchor::AtHeight {
                block_height: height,
            },
        }),
        cursor: None,
        limit: Some(10),
    }
}

async fn indexed_created_events(
    ctx: &AgentContext,
    factory: ContractAddress,
    height: thruput_json_rpc_types::BlockHeight,
) -> Result<Vec<IdentifiedEvent>> {
    for _ in 0..40 {
        let page = ctx
            .network()
            .get_events(event_query(factory, height.clone()))
            .await?;
        if page.latest_indexed_block_height >= height {
            assert!(page.events.iter().all(|event| event.block_height == height));
            return Ok(page.events);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("event index did not reach block {}", *height)
}

fn spec_names<'a>(value: &'a serde_json::Value, key: &str) -> Vec<&'a str> {
    value[key]
        .as_array()
        .expect("spec collection")
        .iter()
        .map(|item| item["name"].as_str().expect("named spec item"))
        .collect()
}

/// The `declared` identifier of each structured spec id (events, type defs),
/// sorted: the spec lists them grouped by declaring crate, which is not a
/// property these checks are about.
fn declared_names<'a>(value: &'a serde_json::Value, key: &str) -> Vec<&'a str> {
    let mut names: Vec<&str> = value[key]
        .as_array()
        .expect("spec collection")
        .iter()
        .map(|item| {
            item["name"]["declared"]
                .as_str()
                .expect("structured spec id")
        })
        .collect();
    names.sort_unstable();
    names
}

fn named<'a>(items: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    items
        .as_array()
        .expect("spec collection")
        .iter()
        .find(|item| item["name"] == name || item["name"]["declared"] == name)
        .unwrap_or_else(|| panic!("missing spec item {name}"))
}

fn assert_generated_specs(root: &Path) {
    let factory: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("standard_token_factory.spec.json")).expect("read factory spec"),
    )
    .expect("parse factory spec");
    let token: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("standard_token.spec.json")).expect("read token spec"),
    )
    .expect("parse token spec");

    assert_eq!(factory["format"], "gh_contract_spec_v1");
    assert_eq!(token["format"], "gh_contract_spec_v1");
    assert_eq!(factory["interfaces"][0]["version"], FACTORY.1);
    assert_eq!(declared_names(&factory, "events"), ["TokenCreated"]);
    assert_eq!(
        declared_names(&token, "events"),
        [
            "AllowanceChangeEvent",
            "AllowanceDeleteEvent",
            "BurnEvent",
            "ClawbackEvent",
            "MintEvent",
            "TransferEvent"
        ]
    );
    let factory_config = named(&factory["type_defs"], "FactoryConfig");
    assert_eq!(
        spec_names(factory_config, "fields"),
        [
            "token_code_hash",
            "required_token_funding",
            "native_token",
            "creation_fee",
            "fee_recipient"
        ]
    );
    let factory_errors = named(&factory["type_defs"], "TokenFactoryError");
    assert_eq!(
        spec_names(factory_errors, "variants"),
        [
            "AlreadyInitialized",
            "InvalidConfig",
            "InvalidTokenConfig",
            "InsufficientTokenFunding"
        ]
    );
    assert_eq!(
        factory_errors["variants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|variant| variant["value"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    let created = named(&factory["events"], "TokenCreated");
    assert_eq!(spec_names(created, "topics"), ["token", "creator"]);
    assert_eq!(
        spec_names(created, "fields"),
        [
            "administrator",
            "initial_holder",
            "initial_supply",
            "name",
            "symbol",
            "decimals",
            "token_code_hash"
        ]
    );

    let factory_methods = spec_names(&factory["interfaces"][0], "methods");
    for method in [
        "initialize",
        "create_token",
        "predict_token",
        "required_token_funding",
        "creation_fee",
        "config",
    ] {
        assert!(factory_methods.contains(&method));
    }
    let create_token = named(&factory["interfaces"][0]["methods"], "create_token");
    assert_eq!(
        spec_names(create_token, "args"),
        [
            "nonce",
            "administrator",
            "name",
            "symbol",
            "decimals",
            "initial_holder",
            "initial_supply"
        ]
    );
    assert_eq!(create_token["return_type"]["kind"], "address");
    let interfaces = spec_names(&token, "interfaces");
    assert_eq!(
        interfaces,
        [
            "ERC20",
            "ERC20Burn",
            "ERC20Clawback",
            "ERC20Metadata",
            "StandardTokenInitializer"
        ]
    );
    assert_eq!(token["interfaces"][0]["version"], ERC20.1);
    assert_eq!(token["interfaces"][3]["version"], METADATA.1);
    let erc20_methods = spec_names(&token["interfaces"][0], "methods");
    for method in [
        "mint",
        "transfer",
        "adjust_allowance",
        "transfer_from",
        "total_supply",
    ] {
        assert!(erc20_methods.contains(&method));
    }
    assert_eq!(
        spec_names(named(&token["events"], "AllowanceChangeEvent"), "fields"),
        ["difference"]
    );
    assert_eq!(
        spec_names(named(&token["events"], "TransferEvent"), "fields"),
        ["amount"]
    );

    for spec in ["standard_token.spec.xdr", "standard_token_factory.spec.xdr"] {
        assert!(std::fs::metadata(root.join(spec)).unwrap().len() > 0);
    }
}

fn spender_agent() -> Agent {
    Agent::new("spender", |mut ctx| async move {
        let me = ctx.address();
        ctx.send("creator", &me)?;
        let request = ctx
            .recv_from::<SpendRequest>("creator")
            .await
            .expect("creator closed before transfer_from")?
            .body;
        let token = token(&ctx, request.token);
        let receipt = token
            .transfer_from(&request.owner, &me, request.amount)
            .receipt()
            .await?;
        // Spending an allowance emits only the transfer it pays for.
        assert_eq!(receipt.events.len(), 1);
        assert_transfer(
            &receipt,
            0,
            request.token,
            request.owner,
            me,
            request.amount,
        );
        ctx.send("creator", &())?;
        Ok(())
    })
}

fn creator_agent() -> Agent {
    Agent::new("creator", move |mut ctx| async move {
        let creator = ctx.address();
        let spender = ctx
            .recv_from::<ContractAddress>("spender")
            .await
            .expect("spender closed before greeting")?
            .body;
        let native = native_token(&ctx);

        let registration = ctx
            .register_artifact(
                "standard_token",
                DeployOptions::funded(NATIVE_TOKEN_FUNDING as u128),
            )
            .await?;
        assert!(registration.registered);
        assert!(ctx.is_registered("standard_token")?);
        let token_hash = ctx.contract_hash("standard_token")?;

        let unavailable_factory = deploy_factory(
            &mut ctx,
            FactoryConfig {
                token_code_hash: SHA256Hash::from([0xff; 32]),
                required_token_funding: REQUIRED_TOKEN_FUNDING,
                native_token: native.address(),
                creation_fee: 0,
                fee_recipient: None,
            },
        )
        .await?;
        let unavailable_nonce = SHA256Hash::from([0x60; 32]);
        let unavailable_address = predict(&ctx, &unavailable_factory, unavailable_nonce).await?;
        native
            .transfer(&unavailable_address, TOKEN_SOURCE_FUNDING)
            .await?;
        let unavailable_reserve = reserve(&native, unavailable_address).await?;
        let unavailable_config = maximum_config(creator);
        let unavailable = create(
            &unavailable_factory,
            unavailable_nonce,
            &unavailable_config,
            creator,
            1,
        )
        .await?;
        let unavailable_receipt = ctx.network().await_receipt(unavailable.tx_hash()).await?;
        assert!(matches!(
            unavailable_receipt.execution,
            ExecutionResult::Abort { .. }
        ));
        assert!(unavailable_receipt.events.is_empty());
        assert_wallet_call_aborted(&unavailable_receipt);
        assert_eq!(
            reserve(&native, unavailable_address).await?,
            unavailable_reserve
        );
        assert!(
            indexed_created_events(
                &ctx,
                unavailable_factory.address(),
                unavailable_receipt.block_height
            )
            .await?
            .is_empty()
        );

        let factory_config = FactoryConfig {
            token_code_hash: token_hash,
            required_token_funding: REQUIRED_TOKEN_FUNDING,
            native_token: native.address(),
            creation_fee: 0,
            fee_recipient: None,
        };
        let factory = deploy_factory(&mut ctx, factory_config).await?;
        let published = factory.required_token_funding().await?;
        assert_eq!(published, REQUIRED_TOKEN_FUNDING);

        let underfunded_nonce = SHA256Hash::from([0x5f; 32]);
        let underfunded_address = predict(&ctx, &factory, underfunded_nonce).await?;
        native
            .transfer(&underfunded_address, TOKEN_SOURCE_FUNDING - 1)
            .await?;
        let config = maximum_config(creator);
        let underfunded = create(&factory, underfunded_nonce, &config, creator, 1).await?;
        let underfunded_receipt = ctx.network().await_receipt(underfunded.tx_hash()).await?;
        assert!(matches!(
            underfunded_receipt.execution,
            ExecutionResult::Abort { .. }
        ));
        assert!(underfunded_receipt.events.is_empty());
        assert_wallet_call_aborted(&underfunded_receipt);
        assert!(
            indexed_created_events(&ctx, factory.address(), underfunded_receipt.block_height)
                .await?
                .is_empty()
        );

        let nonce = SHA256Hash::from([0x61; 32]);
        let predicted = predict(&ctx, &factory, nonce).await?;
        native.transfer(&predicted, TOKEN_SOURCE_FUNDING).await?;
        let submitted = create(&factory, nonce, &config, creator, 1_000).await?;
        let creation_receipt = submitted.await_receipt().await?;
        assert_eq!(creation_receipt.events.len(), 2);
        // The account's default wallet ran the call and returns one buffer per
        // call it made; unwrap that envelope before decoding the address.
        let ExecutionResult::Return { return_data } = &creation_receipt.execution else {
            panic!(
                "create_token did not return: {:?}",
                creation_receipt.execution
            );
        };
        let returned =
            thruput_signing::default_wallet::decode_default_wallet_call_return(&return_data.0)
                .expect("unwrap the wallet's return");
        let created: ContractAddress =
            xdrs::cxs::decode(returned.as_slice()).expect("decode created token address");
        assert_eq!(created, predicted);
        assert_created(
            &creation_receipt,
            factory.address(),
            created,
            creator,
            &config,
            creator,
            1_000,
            token_hash,
        );
        let indexed = indexed_created_events(
            &ctx,
            factory.address(),
            creation_receipt.block_height.clone(),
        )
        .await?;
        assert_eq!(indexed.len(), 1);
        assert_eq!(
            indexed[0].transaction_hash,
            creation_receipt.transaction_hash
        );
        assert_eq!(indexed[0].sequence_number, 1);
        assert_eq!(indexed[0].event.address, creation_receipt.events[1].address);
        assert_eq!(indexed[0].event.topics, creation_receipt.events[1].topics);
        assert_eq!(indexed[0].event.data.0, creation_receipt.events[1].data.0);

        let token = token(&ctx, created);
        let metadata = metadata(&ctx, created);
        assert_eq!(metadata.name().simulate().await?, config.name);
        assert_eq!(metadata.symbol().simulate().await?, config.symbol);
        assert_eq!(metadata.decimals().simulate().await?, config.decimals);
        assert_eq!(balance(&token, creator).await?, 1_000);
        assert_eq!(token.total_supply().await?, 1_000);
        assert_eq!(reserve(&native, created).await?, 0);

        let mint = token.mint(&creator, 100_i128).receipt().await?;
        assert_eq!(mint.events.len(), 1);
        assert_mint(&mint, 0, created, creator, 100);
        assert_eq!(balance(&token, creator).await?, 1_100);
        assert_eq!(token.total_supply().await?, 1_100);
        assert_eq!(reserve(&native, created).await?, 0);

        native.transfer(&created, ROW_FUNDING).await?;
        let transfer = token.transfer(&spender, 200_i128).receipt().await?;
        assert_eq!(transfer.events.len(), 1);
        assert_transfer(&transfer, 0, created, creator, spender, 200);
        assert_eq!(balance(&token, creator).await?, 900);
        assert_eq!(balance(&token, spender).await?, 200);
        assert_eq!(reserve(&native, created).await?, 0);

        native.transfer(&created, ROW_FUNDING).await?;
        let approval = token.adjust_allowance(&spender, 150_i128).receipt().await?;
        assert_eq!(approval.events.len(), 1);
        assert_allowance_change(&approval, 0, created, creator, spender, 150);
        assert_eq!(balance(&token, creator).await?, 900);
        assert_eq!(balance(&token, spender).await?, 200);
        assert_eq!(reserve(&native, created).await?, 0);
        assert_eq!(token.allowance(&creator, &spender).await?, 150);

        ctx.send(
            "spender",
            &SpendRequest {
                token: created,
                owner: creator,
                amount: 75,
            },
        )?;
        ctx.recv_from::<()>("spender")
            .await
            .expect("spender closed before transfer_from completed")?;
        assert_eq!(balance(&token, creator).await?, 825);
        assert_eq!(balance(&token, spender).await?, 275);
        assert_eq!(token.allowance(&creator, &spender).await?, 75);
        assert_eq!(reserve(&native, created).await?, 0);

        let clawback = ERC20ClawbackRemote::new(ctx.caller().clone(), &created);
        let burn = clawback.clawback(&spender, 25_i128).receipt().await?;
        assert_eq!(burn.events.len(), 2);
        assert_clawback(&burn, 0, created, spender, 25);
        assert_eq!(balance(&token, spender).await?, 250);
        assert_eq!(token.total_supply().await?, 1_075);
        assert_eq!(reserve(&native, created).await?, 0);

        let unseen = ContractAddress::from([0x44; 32]);
        native.transfer(&created, ROW_FUNDING).await?;
        let unseen_transfer = token.transfer(&unseen, 1_i128).receipt().await?;
        assert_eq!(unseen_transfer.events.len(), 1);
        assert_transfer(&unseen_transfer, 0, created, creator, unseen, 1);
        assert_eq!(balance(&token, creator).await?, 824);
        assert_eq!(balance(&token, unseen).await?, 1);
        assert_eq!(reserve(&native, created).await?, 0);

        let fee_factory = deploy_factory(
            &mut ctx,
            FactoryConfig {
                token_code_hash: token_hash,
                required_token_funding: REQUIRED_TOKEN_FUNDING,
                native_token: native.address(),
                creation_fee: CREATION_FEE,
                fee_recipient: Some(spender),
            },
        )
        .await?;
        let fee_nonce = SHA256Hash::from([0x62; 32]);
        let fee_token = predict(&ctx, &fee_factory, fee_nonce).await?;
        native.transfer(&fee_token, TOKEN_SOURCE_FUNDING).await?;
        native
            .transfer(&native.address(), NATIVE_TOKEN_FUNDING)
            .await?;
        native
            .adjust_allowance(&fee_factory.address(), CREATION_FEE)
            .await?;
        let recipient_before = reserve(&native, spender).await?;
        let factory_before = reserve(&native, fee_factory.address()).await?;
        let fee_creation = create(&fee_factory, fee_nonce, &config, creator, 1)
            .await?
            .await_receipt()
            .await?;
        assert_eq!(fee_creation.events.len(), 3);
        assert_transfer(
            &fee_creation,
            0,
            native.address(),
            creator,
            spender,
            CREATION_FEE,
        );
        assert_created(
            &fee_creation,
            fee_factory.address(),
            fee_token,
            creator,
            &config,
            creator,
            1,
            token_hash,
        );
        assert_eq!(
            reserve(&native, spender).await?,
            recipient_before + CREATION_FEE
        );
        assert_eq!(
            reserve(&native, fee_factory.address()).await?,
            factory_before
        );
        assert_eq!(native.allowance(&creator, &fee_factory.address()).await?, 0);

        println!(
            "phase6: token_hash={token_hash:?} unavailable_tx={:?} underfunded_tx={:?} creation_tx={:?} event_query_height={} indexed_events={} creation_sequence=[Transfer,TokenCreated] fee_tx={:?} fee_sequence=[Transfer,Transfer,TokenCreated]",
            unavailable_receipt.transaction_hash,
            underfunded_receipt.transaction_hash,
            creation_receipt.transaction_hash,
            *creation_receipt.block_height,
            indexed.len(),
            fee_creation.transaction_hash,
        );
        Ok(())
    })
}

#[tokio::test]
#[ignore = "requires hog-devnode and built RV32 artifacts"]
async fn real_artifact_rpc_lifecycle() {
    let root = PathBuf::from(
        std::env::var("THRUPUT_TESTKIT_ARTIFACT_ROOT").expect("set THRUPUT_TESTKIT_ARTIFACT_ROOT"),
    );
    assert_generated_specs(&root);
    let binary = std::env::var("THRUPUT_DEVNODE_BINARY")
        .map(PathBuf::from)
        .expect("set THRUPUT_DEVNODE_BINARY");
    let mut config = LocalNetworkConfig::default();
    config.hog_devnode_binary = Some(binary);
    config.initial_account_tokens = 100_000_000_000;

    let scenario = Scenario::builder("standard-token-phase-6")
        .network(NetworkConfig::local(config))
        .artifact("standard_token", root.join("standard_token.rv32a"))
        .artifact(
            "standard_token_factory",
            root.join("standard_token_factory.rv32a"),
        )
        .build()
        .await
        .expect("start fresh protocol-aligned devnode");

    scenario
        .run_agents([creator_agent(), spender_agent()])
        .await
        .expect("complete the token factory RPC lifecycle");
    scenario.stop().await.expect("clean devnode shutdown");
}
