//! Real-artifact storage funding validation on a fresh `hog-devnode`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use groundhog_json_rpc_types::receipt::ExecStatus;
use groundhog_json_rpc_types::transaction::{ConflictCode, TransactionStatus};
use groundhog_testkit::xdr::types::{ContractAddress, SHA256Hash};
use groundhog_testkit::{
    Agent, AgentContext, Contract, LocalNetworkConfig, NetworkConfig, Result, Scenario,
};
use sha2::{Digest, Sha256};
use standard_token::Config;
use standard_token_factory::FactoryConfig;

const ERC20: (&str, &str) = ("ERC20", "0.1.9");
const FACTORY: (&str, &str) = ("StandardTokenFactory", "0.1.0");
const TEST_WALLET: (&str, &str) = ("TokenFactoryTestWallet", "0.1.0");
const REQUIRED_FACTORY_FUNDING: u128 = 1_000_000;
const TOKEN_CODE_HASH: &str = "f7ab4d2c0f21d0251441d7c0d8054c2ff6d0efb223547dbe99e0ffe9f0547503";
const RELEASE_MANIFEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/releases/standard-token-factory-v1.json"
);

fn sha256(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_else(|error| {
        panic!("read release input {}: {error}", path.display());
    });
    hex::encode(Sha256::digest(bytes))
}

fn release_value<'a>(release: &'a serde_json::Value, pointer: &str) -> &'a serde_json::Value {
    release
        .pointer(pointer)
        .unwrap_or_else(|| panic!("release manifest is missing {pointer}"))
}

fn release_str<'a>(release: &'a serde_json::Value, pointer: &str) -> &'a str {
    release_value(release, pointer)
        .as_str()
        .unwrap_or_else(|| panic!("release manifest {pointer} must be a string"))
}

fn release_u128(release: &serde_json::Value, pointer: &str) -> u128 {
    release_value(release, pointer)
        .as_u64()
        .unwrap_or_else(|| panic!("release manifest {pointer} must be an unsigned integer"))
        .into()
}

fn assert_artifact(release: &serde_json::Value, root: &Path, section: &str, artifact_key: &str) {
    let prefix = format!("/{section}");
    let artifact = root.join(release_str(release, &format!("{prefix}/artifact")));
    assert_eq!(
        std::fs::metadata(&artifact)
            .unwrap_or_else(|error| panic!("read {} metadata: {error}", artifact.display()))
            .len() as u128,
        release_u128(release, &format!("{prefix}/artifactBytes")),
        "{artifact_key} artifact size does not match the release manifest"
    );
    assert_eq!(
        sha256(&artifact),
        release_str(release, &format!("{prefix}/artifactSha256")),
        "{artifact_key} artifact hash does not match the release manifest"
    );

    for (suffix, field) in [
        ("spec.json", "specJsonSha256"),
        ("spec.xdr", "specXdrSha256"),
    ] {
        let spec = root.join(format!("{artifact_key}.{suffix}"));
        assert_eq!(
            sha256(&spec),
            release_str(release, &format!("{prefix}/{field}")),
            "{} hash does not match the release manifest",
            spec.display()
        );
    }
}

fn validate_release_inputs(root: &Path, runtime_manifest: &Path, binary: &Path) {
    let release: serde_json::Value = serde_json::from_slice(
        &std::fs::read(RELEASE_MANIFEST).expect("read checked-in release manifest"),
    )
    .expect("parse checked-in release manifest");

    assert_eq!(release_str(&release, "/status"), "release-candidate");
    assert_eq!(release_str(&release, "/sdkVersion"), "0.19.0");
    assert_eq!(release_str(&release, "/erc20InterfaceVersion"), ERC20.1);
    assert_eq!(release_str(&release, "/metadataInterfaceVersion"), ERC20.1);
    assert_eq!(release_str(&release, "/token/codeHash"), TOKEN_CODE_HASH);
    assert_eq!(
        release_str(&release, "/factory/interfaceVersion"),
        FACTORY.1
    );
    assert_eq!(
        release_str(&release, "/testWallet/interfaceVersion"),
        TEST_WALLET.1
    );
    assert_artifact(&release, root, "token", "standard_token");
    assert_artifact(&release, root, "factory", "standard_token_factory");
    assert_artifact(&release, root, "testWallet", "token_factory_test_wallet");

    assert_eq!(
        sha256(runtime_manifest),
        release_str(&release, "/runtime/manifestSha256")
    );
    assert_eq!(
        sha256(binary),
        release_str(&release, "/runtime/binarySha256")
    );
    let runtime_bytes = std::fs::read(runtime_manifest).expect("read runtime manifest");
    let runtime =
        groundhog_json_rpc_types::runtime_manifest::parse_runtime_manifest(&runtime_bytes)
            .expect("parse current runtime manifest");
    assert_eq!(runtime.protocol, release_str(&release, "/protocol"));
    assert_eq!(
        runtime.producer.binary,
        release_str(&release, "/runtime/binary")
    );
    assert_eq!(
        runtime.producer.version,
        release_str(&release, "/runtime/version")
    );
    assert_eq!(
        runtime.producer.commit_hash.as_deref(),
        Some(release_str(&release, "/runtime/commitHash"))
    );
    assert_eq!(
        runtime.bootstrap_accounts.len() as u128,
        release_u128(&release, "/runtime/devAccountCount")
    );
    let account_tokens = release_u128(&release, "/runtime/devAccountTokens").to_string();
    assert!(
        runtime
            .bootstrap_accounts
            .iter()
            .all(|account| account.initial_storage_tokens == account_tokens)
    );
    assert_eq!(
        runtime.bootstrap_account_derivation.seed,
        release_str(&release, "/runtime/devAccountSeed")
    );
    assert_eq!(
        hex::encode(runtime.genesis_hash.0),
        release_str(&release, "/runtime/genesisHash")
    );

    let costs = &runtime.bootstrap.storage_cost_model;
    assert_eq!(
        hex::encode(costs.hash.0),
        release_str(&release, "/storageCostModel/hash")
    );
    for (actual, pointer) in [
        (
            &costs.base_data_item_cost,
            "/storageCostModel/baseDataItemCost",
        ),
        (
            &costs.bytestring_cost_per_byte,
            "/storageCostModel/bytestringCostPerByte",
        ),
        (
            &costs.base_contract_deployment_cost,
            "/storageCostModel/baseContractDeploymentCost",
        ),
        (
            &costs.contract_deployment_cost_per_byte,
            "/storageCostModel/contractDeploymentCostPerByte",
        ),
        (&costs.balance_cost, "/storageCostModel/balanceCost"),
    ] {
        assert_eq!(parse_cost(actual), release_u128(&release, pointer));
    }
    for (pointer, expected) in [
        ("/funding/minimumSourceTransfer", 352_004),
        ("/funding/nativeBalanceCost", 1_234),
        ("/funding/requiredTokenFunding", 350_770),
        ("/funding/conservativeMargin", 0),
        ("/funding/freeReserveAfterMaximumCreation", 0),
        ("/funding/balanceRowCost", 12_000),
        ("/funding/allowanceRowCost", 12_000),
    ] {
        assert_eq!(release_u128(&release, pointer), expected);
    }
}

fn native_token() -> Contract {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    Contract::new(ContractAddress::from(bytes), ERC20.0, ERC20.1)
}

fn token(address: ContractAddress) -> Contract {
    Contract::new(address, ERC20.0, ERC20.1)
}

fn maximum_config(administrator: ContractAddress) -> Config {
    Config {
        administrator,
        name: Some("N".repeat(100).as_str().try_into().unwrap()),
        symbol: Some("S".repeat(10).as_str().try_into().unwrap()),
        decimals: Some(u32::MAX),
    }
}

fn parse_cost(value: &str) -> u128 {
    value.parse().expect("runtime cost is a decimal u128")
}

fn measured_minimum(
    manifest_path: &std::path::Path,
    artifact_bytes: usize,
    administrator: ContractAddress,
) -> u128 {
    let bytes = std::fs::read(manifest_path).expect("read runtime manifest");
    let manifest = groundhog_json_rpc_types::runtime_manifest::parse_runtime_manifest(&bytes)
        .expect("parse current runtime manifest");
    let costs = &manifest.bootstrap.storage_cost_model;
    let config_bytes =
        sdk::xdr::cxs::encode(&maximum_config(administrator)).expect("encode maximum token config");

    parse_cost(&costs.balance_cost)
        + parse_cost(&costs.base_contract_deployment_cost)
        + parse_cost(&costs.contract_deployment_cost_per_byte) * artifact_bytes as u128
        + parse_cost(&costs.base_data_item_cost)
        + parse_cost(&costs.bytestring_cost_per_byte) * config_bytes.len() as u128
        + 2 * parse_cost(&costs.base_data_item_cost)
}

async fn deploy_factory(
    ctx: &mut AgentContext,
    native: &Contract,
    required_funding: u128,
) -> Result<Contract> {
    ctx.register_artifact("standard_token").await?;
    let factory = Contract::new(
        ctx.deploy_artifact("standard_token_factory").await?.address,
        FACTORY.0,
        FACTORY.1,
    );
    native
        .call(
            ctx,
            "transfer",
            &(factory.address(), REQUIRED_FACTORY_FUNDING),
        )
        .await?;
    factory
        .call(
            ctx,
            "initialize",
            &FactoryConfig {
                token_code_hash: ctx.contract_hash("standard_token")?,
                required_token_funding: required_funding,
                native_token: native.address(),
                creation_fee: 0,
                fee_recipient: None,
            },
        )
        .await?;
    Ok(factory)
}

async fn predict(
    ctx: &AgentContext,
    factory: &Contract,
    nonce: SHA256Hash,
) -> Result<ContractAddress> {
    factory
        .view(ctx, "predict_token", &(ctx.address(), nonce), None)
        .await
}

async fn create(
    ctx: &mut AgentContext,
    factory: &Contract,
    nonce: SHA256Hash,
    initial_holder: ContractAddress,
) -> Result<groundhog_testkit::SubmittedContractCall> {
    let config = maximum_config(ctx.address());
    factory
        .submit_call(
            ctx,
            "create_token",
            &(
                nonce,
                config.administrator,
                config.name,
                config.symbol,
                config.decimals,
                initial_holder,
                i128::MAX as u128,
            ),
        )
        .await
}

async fn assert_storage_failure(
    ctx: &AgentContext,
    call: &groundhog_testkit::SubmittedContractCall,
    predicted: ContractAddress,
) -> Result<()> {
    for _ in 0..100 {
        match ctx.network().transaction_status(call.tx_hash()).await? {
            TransactionStatus::RecentFailure { conflict, .. } => {
                assert_eq!(conflict.address.0, predicted);
                assert_eq!(conflict.code, ConflictCode::BoundsExceeded);
                return Ok(());
            }
            TransactionStatus::Pending | TransactionStatus::Unknown => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            status => panic!("expected storage BoundsExceeded, got {status:?}"),
        }
    }
    panic!("storage failure did not reach RecentFailure status")
}

fn measurement_agent(manifest_path: PathBuf, artifact_path: PathBuf) -> Agent {
    Agent::new("measurement", move |mut ctx| async move {
        let artifact_len = std::fs::metadata(&artifact_path)
            .expect("read standard-token artifact metadata")
            .len() as usize;
        assert_eq!(
            hex::encode(ctx.contract_hash("standard_token")?.into_inner()),
            TOKEN_CODE_HASH
        );
        let minimum = measured_minimum(&manifest_path, artifact_len, ctx.address());
        let manifest_bytes = std::fs::read(&manifest_path).expect("read runtime manifest");
        let manifest =
            groundhog_json_rpc_types::runtime_manifest::parse_runtime_manifest(&manifest_bytes)
                .expect("parse current runtime manifest");
        let row_cost = parse_cost(&manifest.bootstrap.storage_cost_model.base_data_item_cost);
        assert_eq!(artifact_len as u128, 30_124);
        assert_eq!(minimum, 352_004);
        assert_eq!(row_cost, 12_000);
        let native = native_token();
        let factory = deploy_factory(&mut ctx, &native, 1).await?;
        let test_wallet = Contract::new(
            ctx.deploy_artifact("token_factory_test_wallet")
                .await?
                .address,
            TEST_WALLET.0,
            TEST_WALLET.1,
        );
        native
            .call(
                &mut ctx,
                "transfer",
                &(test_wallet.address(), REQUIRED_FACTORY_FUNDING),
            )
            .await?;

        let failing_nonce = SHA256Hash::from([0x71; 32]);
        let failing_address = predict(&ctx, &factory, failing_nonce).await?;
        native
            .call(&mut ctx, "transfer", &(failing_address, minimum - 1))
            .await?;
        let failed = create(&mut ctx, &factory, failing_nonce, test_wallet.address()).await?;
        assert_storage_failure(&ctx, &failed, failing_address).await?;

        let successful_nonce = SHA256Hash::from([0x72; 32]);
        let successful_address = predict(&ctx, &factory, successful_nonce).await?;
        native
            .call(&mut ctx, "transfer", &(successful_address, minimum))
            .await?;
        let succeeded = create(&mut ctx, &factory, successful_nonce, test_wallet.address()).await?;
        let receipt = succeeded.await_receipt().await?;
        assert!(matches!(receipt.status, ExecStatus::Ok));

        let created = token(successful_address);
        let supply: u128 = created.view(&ctx, "total_supply", &(), None).await?;
        let holder_balance: u128 = created
            .view(&ctx, "get_balance_of", &test_wallet.address(), None)
            .await?;
        let free_reserve: u128 = native
            .view(&ctx, "get_balance_of", &successful_address, None)
            .await?;
        assert_eq!(supply, i128::MAX as u128);
        assert_eq!(holder_balance, supply);
        assert_eq!(free_reserve, 0);
        assert_eq!(
            minimum - parse_cost(&manifest.bootstrap.storage_cost_model.balance_cost),
            350_770
        );

        let receiver = ContractAddress::from([0x42; 32]);
        let unfunded_transfer = test_wallet
            .submit_call(
                &mut ctx,
                "top_up_and_transfer",
                &(
                    native.address(),
                    successful_address,
                    receiver,
                    0_u128,
                    1_u128,
                ),
            )
            .await?;
        assert_storage_failure(&ctx, &unfunded_transfer, successful_address).await?;

        test_wallet
            .call(
                &mut ctx,
                "top_up_and_transfer",
                &(
                    native.address(),
                    successful_address,
                    receiver,
                    row_cost,
                    1_u128,
                ),
            )
            .await?;
        let receiver_balance: u128 = created
            .view(&ctx, "get_balance_of", &receiver, None)
            .await?;
        let reserve_after_row: u128 = native
            .view(&ctx, "get_balance_of", &successful_address, None)
            .await?;
        assert_eq!(receiver_balance, 1);
        assert_eq!(reserve_after_row, 0);

        let wallet_native_before: u128 = native
            .view(&ctx, "get_balance_of", &test_wallet.address(), None)
            .await?;
        let failed_atomic_transfer = test_wallet
            .submit_call(
                &mut ctx,
                "top_up_and_transfer",
                &(
                    native.address(),
                    successful_address,
                    ContractAddress::from([0x43; 32]),
                    row_cost,
                    i128::MAX as u128,
                ),
            )
            .await?;
        let failed_receipt = failed_atomic_transfer.await_receipt().await;
        assert!(failed_receipt.is_err());
        let wallet_native_after: u128 = native
            .view(&ctx, "get_balance_of", &test_wallet.address(), None)
            .await?;
        let reserve_after_failure: u128 = native
            .view(&ctx, "get_balance_of", &successful_address, None)
            .await?;
        assert_eq!(wallet_native_after, wallet_native_before);
        assert_eq!(reserve_after_failure, 0);

        let spender = ContractAddress::from([0x52; 32]);
        let underfunded_allowance = test_wallet
            .submit_call(
                &mut ctx,
                "top_up_and_adjust_allowance",
                &(
                    native.address(),
                    successful_address,
                    spender,
                    row_cost - 1,
                    100_i128,
                ),
            )
            .await?;
        assert_storage_failure(&ctx, &underfunded_allowance, successful_address).await?;

        test_wallet
            .call(
                &mut ctx,
                "top_up_and_adjust_allowance",
                &(
                    native.address(),
                    successful_address,
                    spender,
                    row_cost,
                    100_i128,
                ),
            )
            .await?;
        let allowance: u128 = created
            .view(&ctx, "allowance", &(test_wallet.address(), spender), None)
            .await?;
        assert_eq!(allowance, 100);

        let wallet_native_before: u128 = native
            .view(&ctx, "get_balance_of", &test_wallet.address(), None)
            .await?;
        let failed_atomic_allowance = test_wallet
            .submit_call(
                &mut ctx,
                "top_up_and_adjust_allowance",
                &(
                    native.address(),
                    successful_address,
                    spender,
                    row_cost,
                    -101_i128,
                ),
            )
            .await?;
        assert!(failed_atomic_allowance.await_receipt().await.is_err());
        let wallet_native_after: u128 = native
            .view(&ctx, "get_balance_of", &test_wallet.address(), None)
            .await?;
        let allowance_after: u128 = created
            .view(&ctx, "allowance", &(test_wallet.address(), spender), None)
            .await?;
        assert_eq!(wallet_native_after, wallet_native_before);
        assert_eq!(allowance_after, 100);

        println!(
            "phase5: artifact_bytes={artifact_len} measured_minimum={minimum} row_cost={row_cost} code_hash={:?}",
            ctx.contract_hash("standard_token")?
        );
        Ok(())
    })
}

fn publication_agent(manifest_path: PathBuf, artifact_path: PathBuf) -> Agent {
    Agent::new("publication", move |mut ctx| async move {
        let artifact_len = std::fs::metadata(&artifact_path)
            .expect("read standard-token artifact metadata")
            .len() as usize;
        assert_eq!(
            hex::encode(ctx.contract_hash("standard_token")?.into_inner()),
            TOKEN_CODE_HASH
        );
        let minimum = measured_minimum(&manifest_path, artifact_len, ctx.address());
        let manifest_bytes = std::fs::read(&manifest_path).expect("read runtime manifest");
        let manifest =
            groundhog_json_rpc_types::runtime_manifest::parse_runtime_manifest(&manifest_bytes)
                .expect("parse current runtime manifest");
        let native = native_token();
        let balance_cost = parse_cost(&manifest.bootstrap.storage_cost_model.balance_cost);
        let factory_threshold = minimum - balance_cost;
        assert_eq!(minimum, 352_004);
        assert_eq!(balance_cost, 1_234);
        assert_eq!(factory_threshold, 350_770);
        let factory = deploy_factory(&mut ctx, &native, factory_threshold).await?;
        let published: u128 = factory
            .view(&ctx, "required_token_funding", &(), None)
            .await?;
        assert_eq!(published, factory_threshold);

        let nonce = SHA256Hash::from([0x73; 32]);
        let address = predict(&ctx, &factory, nonce).await?;
        native
            .call(&mut ctx, "transfer", &(address, minimum))
            .await?;
        let holder = ctx.address();
        let created = create(&mut ctx, &factory, nonce, holder).await?;
        let receipt = ctx.network().await_receipt(created.tx_hash()).await?;
        assert!(
            matches!(receipt.status, ExecStatus::Ok),
            "published funding creation failed: status={:?}, abort={:?}",
            receipt.status,
            receipt.abort_data
        );
        Ok(())
    })
}

#[tokio::test]
#[ignore = "requires hog-devnode and release-candidate artifacts"]
async fn release_candidate_storage_funding() {
    let root = PathBuf::from(
        std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT")
            .expect("set GROUNDHOG_TESTKIT_ARTIFACT_ROOT"),
    );
    let binary = std::env::var("GROUNDHOG_DEVNODE_BINARY")
        .map(PathBuf::from)
        .expect("set GROUNDHOG_DEVNODE_BINARY");
    let manifest_path = std::env::var("GROUNDHOG_RUNTIME_MANIFEST")
        .map(PathBuf::from)
        .expect("set GROUNDHOG_RUNTIME_MANIFEST to a manifest from this exact devnode build");
    validate_release_inputs(&root, &manifest_path, &binary);
    let mut config = LocalNetworkConfig::default();
    config.hog_devnode_binary = Some(binary);
    config.hogd_protocol = Some("hogp/0cd3c454cdeb".to_owned());
    config.dev_account_count = 10;
    config.dev_account_seed = "groundhog-dev-accounts".to_owned();
    config.dev_account_tokens = 1_000_000_000;

    let scenario = Scenario::builder("standard-token-phase-5")
        .network(NetworkConfig::local(config))
        .artifact("standard_token", root.join("standard_token.rv32a"))
        .artifact(
            "standard_token_factory",
            root.join("standard_token_factory.rv32a"),
        )
        .artifact(
            "token_factory_test_wallet",
            root.join("token_factory_test_wallet.rv32a"),
        )
        .build()
        .await
        .expect("start fresh protocol-aligned devnode");

    scenario
        .run_agents([
            measurement_agent(manifest_path.clone(), root.join("standard_token.rv32a")),
            publication_agent(manifest_path, root.join("standard_token.rv32a")),
        ])
        .await
        .expect("measure current release-candidate storage funding");
    scenario.stop().await.expect("clean devnode shutdown");
}
