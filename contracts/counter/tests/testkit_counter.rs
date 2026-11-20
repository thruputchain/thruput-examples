//! Deploy and call Counter on a fresh local node with Testkit.
//! See the Counter README for the build and run commands.

use std::path::PathBuf;

use counter::CounterRemote;
use thruput_testkit::{Agent, DeployOptions, LocalNetworkConfig, NetworkConfig, Scenario};

#[tokio::test]
#[ignore = "requires a devnode binary and built Counter artifact; see contracts/counter/README.md"]
async fn counter_increments_on_a_local_node() {
    let root = std::env::var("THRUPUT_TESTKIT_ARTIFACT_ROOT")
        .expect("set THRUPUT_TESTKIT_ARTIFACT_ROOT; see contracts/counter/README.md");
    let binary = std::env::var("THRUPUT_DEVNODE_BINARY")
        .expect("set THRUPUT_DEVNODE_BINARY; see contracts/counter/README.md");

    let mut config = LocalNetworkConfig::default();
    config.hog_devnode_binary = Some(binary.into());
    let scenario = Scenario::builder("counter")
        .network(NetworkConfig::local(config))
        .artifact("counter", PathBuf::from(root).join("counter.rv32a"))
        .build()
        .await
        .expect("start a local node with the Counter artifact");

    // An agent has its own funded account and sends calls through that account.
    let alice = Agent::new("alice", |mut ctx| async move {
        // Native tokens fund the contract's deployment and storage.
        let deployed = ctx
            .deploy_artifact("counter", DeployOptions::funded(1_000_000))
            .await?;
        let counter = CounterRemote::new(ctx.caller().clone(), &deployed.address);

        assert_eq!(counter.get().await?, 0);
        counter.increment(5).await?;
        assert_eq!(counter.get().await?, 5);
        Ok(())
    });

    let result = scenario.run_agents([alice]).await;
    // Stop the node before reporting an agent failure.
    scenario.stop().await.expect("stop the local node");
    result.expect("Alice increments the counter from 0 to 5");
}
