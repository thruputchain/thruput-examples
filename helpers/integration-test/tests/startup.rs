//! Exercise the CLI environment handoff in fresh processes, without mutating
//! the test runner's environment or requiring a live node.
use integration_test::Harness;
use std::process::Command;
use thruput_json_rpc_types::NetworkHashText;
use thruput_json_rpc_types::base58::Base58;
use thruput_signing::{LocalSigner, PubkeyAccount};
use thruput_xdr::types::{ContractAddress, Ed25519PublicKey, SHA256Hash};

const INPUTS: [&str; 3] = [
    "THRUPUT_RPC_URL",
    "THRUPUT_CONTRACT_ADDRESS",
    "THRUPUT_RUNTIME_MANIFEST",
];

#[test]
fn child_startup() {
    if std::env::var_os("STARTUP_TEST_CHILD").is_none() {
        return;
    }
    let harness = Harness::from_env("Counter", "0.1.0");
    let signer = LocalSigner::from_secret_key([0x37; 32]);
    assert_eq!(
        harness.wallet(),
        PubkeyAccount::from_public_key_bytes(signer.verifying_key_bytes(), 0).address()
    );
}

#[test]
fn renamed_environment_and_stored_key_start_the_harness() {
    let fixture = tempfile::tempdir().expect("fixture directory");
    let signer = LocalSigner::from_secret_key([0x37; 32]);
    let wallet = PubkeyAccount::from_public_key_bytes(signer.verifying_key_bytes(), 0).address();
    let keys = fixture.path().join("thruput/keys");
    std::fs::create_dir_all(&keys).expect("fixture keys directory");
    let key = keys.join("integration.json");
    // Fixed, test-only key in the CLI's stored-key format. Production loading
    // remains delegated to the CLI, including permission and key validation.
    let value = serde_json::json!({"version": 1, "scheme": "ed25519", "keypair_hex": hex::encode(signer.to_keypair_bytes())});
    std::fs::write(&key, serde_json::to_vec(&value).expect("key JSON")).expect("fixture key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600))
            .expect("key permissions");
    }
    let manifest = fixture.path().join("runtime-manifest.json");
    let value = serde_json::json!({
        "schemaVersion": 5, "kind": "hogd-dev-runtime", "chainState": "fresh",
        "networkHash": NetworkHashText::from([0x42; 32]), "protocol": "hogp/test00000000000",
        "producer": {"binary": "hogd-dev", "version": "0.1.0", "commitHash": "test"},
        "endpoints": {"scheduler": "127.0.0.1:1000", "schedulerGateway": "127.0.0.1:1010", "indexer": "127.0.0.1:1001", "dbGateway": "127.0.0.1:1002", "viewGateway": "127.0.0.1:1003"},
        "bootstrapAccounts": [{"role": "local_user", "publicKey": Base58(Ed25519PublicKey::from(signer.verifying_key_bytes())), "walletAddress": Base58(wallet), "initialStorageTokens": "10000000000000"}],
        "bootstrap": {"storageCostModel": {"hash": Base58(SHA256Hash::from([0x53; 32])), "baseDataItemCost": "12000", "bytestringCostPerByte": "10", "baseContractDeploymentCost": "12000", "contractDeploymentCostPerByte": "10", "authPerKeyCost": "1111", "rcqCostPerEntry": "8", "replayCacheCostPerEntry": "7", "balanceCost": "1234"}}
    });
    std::fs::write(
        &manifest,
        serde_json::to_vec(&value).expect("manifest JSON"),
    )
    .expect("fixture manifest");
    let values = [
        "http://127.0.0.1:1".to_owned(),
        Base58(ContractAddress::from([0; 32])).to_string(),
        manifest.display().to_string(),
    ];
    let run = |missing: Option<&str>, legacy_only: bool| {
        let mut cmd = Command::new(std::env::current_exe().expect("test binary"));
        cmd.args(["--exact", "child_startup", "--nocapture"])
            .env("STARTUP_TEST_CHILD", "1")
            .env("XDG_CONFIG_HOME", fixture.path())
            .env_remove("THRUPUT_DEFAULT_KEY");
        if missing != Some("THRUPUT_DEFAULT_KEY") {
            cmd.env("THRUPUT_DEFAULT_KEY", "integration");
        }
        for (name, value) in INPUTS.iter().zip(&values) {
            cmd.env_remove(name);
            let old = name.replace("THRUPUT_", "GROUNDHOG_");
            cmd.env_remove(&old);
            if legacy_only {
                cmd.env(old, value);
            } else if missing != Some(*name) {
                cmd.env(name, value);
            }
        }
        cmd.output().expect("startup subprocess")
    };
    let success = run(None, false);
    assert!(
        success.status.success(),
        "startup failed: {}",
        String::from_utf8_lossy(&success.stderr)
    );
    for name in INPUTS {
        let output = run(Some(name), false);
        assert!(!output.status.success(), "startup accepted missing {name}");
        assert!(String::from_utf8_lossy(&output.stderr).contains(name));
    }
    let missing_key = run(Some("THRUPUT_DEFAULT_KEY"), false);
    assert!(!missing_key.status.success());
    assert!(String::from_utf8_lossy(&missing_key.stderr).contains("THRUPUT_DEFAULT_KEY"));
    let legacy = run(None, true);
    assert!(
        !legacy.status.success(),
        "startup accepted only legacy environment names"
    );
    assert!(String::from_utf8_lossy(&legacy.stderr).contains("THRUPUT_RPC_URL"));
}
