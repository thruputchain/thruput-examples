//! Multi-agent simulation
//!
//! Required environment:
//!     GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/path/to/guest/binaries

use std::path::PathBuf;

use groundhog_testkit::rpc_types::receipt::ExecStatus;
use groundhog_testkit::rpc_types::view::RootInvocationOutput;
use groundhog_testkit::xdr::types::ContractAddress;
use groundhog_testkit::{
    Agent, AgentContext, LocalTargetConfig, Result, Scenario, TargetConfig, ContractEntrypointID, entrypoint_id,
};
use groundhog_testkit::xdrs::cxs::encode;

fn erc20_artifact() -> Option<PathBuf> {
    let root = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT").ok()?;
    Some(PathBuf::from(root).join("erc20.rv32a"))
}

struct SwapContext {
    agent_ctx: AgentContext,

    token0: ContractAddress,
}

impl SwapContext {
    pub fn token0(&mut self) -> ERC20 {
        ERC20 {
            agent_ctx: &mut self.agent_ctx,
            address: &self.token0,
        }
    }
}

struct ERC20<'a> {
    pub agent_ctx: &'a mut AgentContext,
    pub address: &ContractAddress,
}

impl ERC20 {
    fn method_entrypoint(method_name: &str) -> ContractEntrypointID {
        entrypoint_id("ERC20", "0.1.0", method_name)
    }

    async fn initialize(administrator: &ContractAddress) {
        let method_name = "initialize";
        let args = encode(&(administrator,));
        let receipt = self.agent_ctx.call(self.address, Self::method_entrypoint(method_name), args.as_bytes()).await?;
        assert!(
            matches!(receipt.status, ExecStatus::Ok),
            "method {} reverted: {:?}",
            method_name,
            receipt.status
        );
    }
}

#[tokio::test]
#[ignore = "requires GROUNDHOG_DEVNODE_BINARY and a built caller-counter fixture in GROUNDHOG_TESTKIT_ARTIFACT_ROOT"]
async fn caller_counter_deploy_call_read() {
    let Some(artifact) = caller_counter_artifact() else {
        eprintln!(
            "skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT to a directory containing \
             caller_counter.rv32a (see scripts/smoke-testkit-local.sh)"
        );
        return;
    };

    let mut config = LocalTargetConfig::default();
    // config.log_level = Some(groundhog_testkit::LogLevel::Trace);
    if let Ok(path) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(path.into());
    }
    if let Ok(protocol) = std::env::var("HOGD_PROTOCOL_OVERRIDE") {
        config.hogd_protocol = Some(protocol);
    }

    let scenario = Scenario::builder("caller-counter-smoke")
        .target(TargetConfig::local(config))
        .artifact("caller-counter", artifact)
        .build()
        .await
        .expect("local node starts and advertises a runtime manifest");

    let report = scenario
        .run_agents([Agent::new("alice", |mut ctx| async move {
            // The first deploy carries the binary (registers it) and creates an
            // instance; the harness reports it registered.
            let instance1 = ctx.deploy_artifact("caller-counter").await?;
            assert!(instance1.registered, "first deploy registers the binary");
            assert!(ctx.is_registered("caller-counter")?);

            // The second deploy is hash-only and yields a distinct instance.
            let instance2 = ctx.deploy_artifact("caller-counter").await?;
            assert!(!instance2.registered, "second deploy is hash-only");
            assert_ne!(
                instance1.address, instance2.address,
                "each deploy is a distinct instance"
            );

            // Write/read round-trip on the first instance as this agent's wallet.
            let caller = ctx.address();

            bump_counter(&mut ctx, instance1.address).await?;
            let after_first = read_counter(&ctx, instance1.address, caller).await?;

            bump_counter(&mut ctx, instance1.address).await?;
            let after_second = read_counter(&ctx, instance1.address, caller).await?;

            assert!(after_first >= 1, "counter is at least 1 after one bump");
            assert_eq!(
                after_second,
                after_first + 1,
                "each bump increments the caller's counter"
            );
            Ok(())
        })])
        .await
        .expect("agent runs to completion");

    assert!(report.all_ok(), "scenario failed: {report:?}");
    scenario.stop().await.expect("clean teardown");
}

/*
/// Read the caller's counter via `groundhog_view`, decoding the CXS `u64`.
///
/// `get()` keys on `msg.sender`, so the view must run with `caller` set to the
/// same wallet that issued the `bump()`; the node installs it as a parent frame.
async fn read_counter(
    ctx: &AgentContext,
    contract: ContractAddress,
    caller: ContractAddress,
) -> Result<u64> {
    let get = entrypoint_id(INTERFACE, VERSION, "get");
    let response = ctx
        .network()
        .view_call(contract, get, &[], Some(caller))
        .await?;
    match response.output {
        RootInvocationOutput::Return { return_data } => {
            Ok(groundhog_testkit::xdrs::cxs::decode::<u64>(&return_data.0)
                .expect("get() return decodes as a u64"))
        }
        other => panic!("get() did not return a value: {other:?}"),
    }
}

async fn bump_counter(
    ctx: &mut AgentContext,
    contract: ContractAddress,
) -> Result<()> {
    let receipt = ctx
        .call(
            contract,
            entrypoint_id(INTERFACE, VERSION, "bump"),
            &[],
        )
        .await?;
    assert!(
        matches!(receipt.status, ExecStatus::Ok),
        "bump reverted: {:?}",
        receipt.status
    );
    Ok(())
}
*/


