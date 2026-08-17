//! Real-artifact storage funding validation on a fresh `hog-devnode`.

use groundhog_json_rpc_types::receipt::ExecStatus;
use groundhog_testkit::xdr::types::{ContractAddress, SHA256Hash};
use groundhog_testkit::{
    Agent, AgentContext, Contract, LocalNetworkConfig, NetworkConfig, Result, Scenario,
};
use standard_token::Config;
use standard_token_factory::{FactoryConfig, TokenFactoryError};
use std::path::PathBuf;

const ERC20: (&str, &str) = ("ERC20", "0.1.9");
const FACTORY: (&str, &str) = ("StandardTokenFactory", "0.1.0");
const REQUIRED_FACTORY_FUNDING: u128 = 1_000_000;

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

fn storage_funding_agent(manifest_path: PathBuf, artifact_path: PathBuf) -> Agent {
    Agent::new("storage-funding", move |mut ctx| async move {
        let artifact_len = std::fs::metadata(&artifact_path)
            .expect("read standard-token artifact metadata")
            .len() as usize;
        let minimum = measured_minimum(&manifest_path, artifact_len, ctx.address());
        let manifest_bytes = std::fs::read(&manifest_path).expect("read runtime manifest");
        let manifest =
            groundhog_json_rpc_types::runtime_manifest::parse_runtime_manifest(&manifest_bytes)
                .expect("parse current runtime manifest");
        let balance_cost = parse_cost(&manifest.bootstrap.storage_cost_model.balance_cost);
        let required_funding = minimum - balance_cost;
        let native = native_token();
        let factory = deploy_factory(&mut ctx, &native, required_funding).await?;
        let published: u128 = factory
            .view(&ctx, "required_token_funding", &(), None)
            .await?;
        assert_eq!(published, required_funding);

        let failing_nonce = SHA256Hash::from([0x71; 32]);
        let failing_address = predict(&ctx, &factory, failing_nonce).await?;
        native
            .call(&mut ctx, "transfer", &(failing_address, minimum - 1))
            .await?;
        let failing_holder = ctx.address();
        let failed = create(&mut ctx, &factory, failing_nonce, failing_holder).await?;
        let failed_receipt = ctx.network().await_receipt(failed.tx_hash()).await?;
        assert!(matches!(failed_receipt.status, ExecStatus::Reverted { .. }));
        let abort_data = failed_receipt
            .abort_data
            .expect("underfunded creation includes abort data");
        let exception =
            sdk::exn::RawException::from_abort_buf(&abort_data.0).expect("parse factory exception");
        assert_eq!(
            exception.try_as::<TokenFactoryError>(),
            Some(TokenFactoryError::InsufficientTokenFunding)
        );

        let successful_nonce = SHA256Hash::from([0x72; 32]);
        let successful_address = predict(&ctx, &factory, successful_nonce).await?;
        native
            .call(&mut ctx, "transfer", &(successful_address, minimum))
            .await?;
        let holder = ctx.address();
        let succeeded = create(&mut ctx, &factory, successful_nonce, holder).await?;
        let receipt = succeeded.await_receipt().await?;
        assert!(matches!(receipt.status, ExecStatus::Ok));

        let created = token(successful_address);
        let supply: u128 = created.view(&ctx, "total_supply", &(), None).await?;
        let holder_balance: u128 = created.view(&ctx, "get_balance_of", &holder, None).await?;
        let free_reserve: u128 = native
            .view(&ctx, "get_balance_of", &successful_address, None)
            .await?;
        assert_eq!(supply, i128::MAX as u128);
        assert_eq!(holder_balance, supply);
        assert_eq!(free_reserve, 0);
        Ok(())
    })
}

#[tokio::test]
#[ignore = "requires hog-devnode and built RV32 artifacts"]
async fn storage_funding_on_fresh_devnode() {
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
    let mut config = LocalNetworkConfig::default();
    config.hog_devnode_binary = Some(binary);

    let scenario = Scenario::builder("standard-token-storage-funding")
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
        .run_agents([storage_funding_agent(
            manifest_path,
            root.join("standard_token.rv32a"),
        )])
        .await
        .expect("validate storage funding on a fresh devnode");
    scenario.stop().await.expect("clean devnode shutdown");
}
