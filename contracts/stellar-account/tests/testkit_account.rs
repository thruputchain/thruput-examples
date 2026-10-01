//! The account on a live `hog-devnode`: the chain's own weight check, which
//! the native mock does not perform.
//!
//! An `admin` agent registers the account code, deploys and configures the
//! factory, funds the predicted address with native HOG, and creates an
//! account for a test-only master key. Then it drives the account directly
//! with hand-built transactions whose invoked address is the account and
//! whose auth claim is a source-address claim: add a second signer at
//! weight 1, raise the high threshold to 2, and show that a threshold change
//! signed by the master alone is refused at admission while one signed by
//! both keys lands.
//!
//! `#[ignore]`d because it needs a devnode binary and built artifacts:
//!
//! ```text
//! cd groundhog-examples
//! for c in stellar-account stellar-account-factory; do groundhog build -p "$c"; done
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=/path/to/target/groundhog \
//!     cargo test -p stellar-account --test testkit_account -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use groundhog_domain_separator::transaction_signature_preimage;
use groundhog_json_rpc_client::GroundhogApiClient;
use groundhog_signing::{
    BuildCallTransaction, LocalSigner, Signer, build_call_transaction,
    encode_signed_transaction_xdr,
};
use groundhog_testkit::xdr::auth_claim::{AuthClaim, AuthClaim_source_address_claim};
use groundhog_testkit::xdr::transaction::{DecoratedSignature, SignedTransaction};
use groundhog_testkit::xdr::types::{ContractAddress, Ed25519PublicKey, NetworkHash, SHA256Hash};
use groundhog_testkit::{
    Agent, AgentContext, Contract, LocalNetworkConfig, NetworkConfig, Scenario, entrypoint_id, xdrs,
};
use stellar_account_factory_if::FactoryConfig;

type Address = ContractAddress;

const ACCOUNT_IF: (&str, &str) = ("StellarAccount", "0.1.0");
const FACTORY_IF: (&str, &str) = ("StellarAccountFactory", "0.1.0");
const ERC20: (&str, &str) = ("ERC20", "0.1.3");

const MASTER_SEED: [u8; 32] = [0x11; 32];
const SECOND_SEED: [u8; 32] = [0x22; 32];

/// Every slot the chain has: hogd rejects any bit at or past slot 21 as `kAuthMalformed`.
const ALL_SLOTS: u32 = (1u32 << 21) - 1;

/// Starting balance for the account: covers deployment storage, the
/// account's own storage writes, and gas for the transactions below.
const STARTING_BALANCE: u128 = 5_000_000_000;
const REQUIRED_FUNDING: u128 = 1_000_000_000;
const GAS_LIMIT: u64 = 10_000_000;
const HORIZON: i64 = 1_000;

fn native_token() -> Contract {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    Contract::new(ContractAddress::from(bytes), ERC20.0, ERC20.1)
}

fn public_key(seed: &[u8; 32]) -> Ed25519PublicKey {
    Ed25519PublicKey::from(LocalSigner::from_secret_key(*seed).verifying_key_bytes())
}

fn source_claim(required_weight: u32) -> AuthClaim {
    AuthClaim::kSourceAddressAuthData {
        source_address_claim: AuthClaim_source_address_claim {
            allowed_keys: ALL_SLOTS,
            required_weight,
        },
    }
}

async fn network_hash(ctx: &AgentContext) -> NetworkHash {
    let client = ctx
        .network()
        .client()
        .expect("a local network has an RPC client");
    let info = client.network_info().await.expect("networkInfo answers");
    let hex = serde_json::to_value(info.network_hash).expect("serializes");
    let hex = hex.as_str().expect("hex string");
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(hex.trim_start_matches("0x"), &mut bytes).expect("32 bytes");
    NetworkHash::new(SHA256Hash::new(bytes))
}

/// Build a transaction invoking `method` on `account`, claim `required_weight`,
/// and sign it with every signer in `signers` (slot, key) in slot order.
/// `network` is computed once by the caller and passed in to avoid a round-trip per call.
#[allow(clippy::too_many_arguments)]
async fn account_tx<A: xdrs::WriteXDR>(
    ctx: &AgentContext,
    network: &NetworkHash,
    account: Address,
    method: &str,
    args: &A,
    required_weight: u32,
    signers: &[(u32, &LocalSigner)],
    nonce: u64,
) -> String {
    let tip = ctx.network().chain_tip().await.expect("chain tip");
    let tx = build_call_transaction(BuildCallTransaction {
        invoked_address: account,
        entrypoint: entrypoint_id(ACCOUNT_IF.0, ACCOUNT_IF.1, method),
        calldata: xdrs::cxs::encode(args).expect("encode args"),
        gas_limit: GAS_LIMIT,
        block_expiry_height: *tip.height + HORIZON,
        nonce,
        auth_claim: source_claim(required_weight),
    });
    let preimage = transaction_signature_preimage(network, &tx).expect("preimage");
    let signatures: Vec<DecoratedSignature> = signers
        .iter()
        .map(|(slot, signer)| DecoratedSignature {
            public_key_id: *slot,
            signature: signer.sign(&preimage).expect("sign"),
        })
        .collect();
    let stx = SignedTransaction {
        tx,
        signatures: signatures.try_into().expect("fits"),
    };
    format!(
        "0x{}",
        hex::encode(encode_signed_transaction_xdr(&stx).expect("encode"))
    )
}

async fn submit_ok(ctx: &AgentContext, tx_hex: String) {
    let hash = ctx
        .network()
        .submit_raw(tx_hex)
        .await
        .expect("accepted at admission");
    let receipt = ctx.network().await_receipt(hash).await.expect("receipt");
    assert!(
        matches!(
            receipt.status,
            groundhog_json_rpc_types::receipt::ExecStatus::Ok
        ),
        "execution ok, got {:?}",
        receipt.status
    );
}

fn admin() -> Agent {
    Agent::new("admin", |mut ctx| async move {
        let native = native_token();
        let master = LocalSigner::from_secret_key(MASTER_SEED);
        let second = LocalSigner::from_secret_key(SECOND_SEED);

        // Code and factory. `register_artifact` deploys a throwaway first
        // instance; only the registered hash matters here.
        ctx.register_artifact("stellar_account").await?;
        let account_hash = ctx.contract_hash("stellar_account")?;
        let factory = Contract::new(
            ctx.deploy_artifact("stellar_account_factory")
                .await?
                .address,
            FACTORY_IF.0,
            FACTORY_IF.1,
        );
        native
            .call(&mut ctx, "transfer", &(factory.address(), REQUIRED_FUNDING))
            .await?;
        factory
            .call(
                &mut ctx,
                "initialize",
                &FactoryConfig {
                    account_code_hash: account_hash,
                    native_token: native.address(),
                    required_funding: REQUIRED_FUNDING,
                },
            )
            .await?;

        // Create the account for the master key: fund the prediction, then create.
        let master_pk = public_key(&MASTER_SEED);
        let predicted: Address = factory.view(&ctx, "address_of", &master_pk, None).await?;
        native
            .call(&mut ctx, "transfer", &(predicted, STARTING_BALANCE))
            .await?;
        let account: Address = factory
            .call_returning(&mut ctx, "create_account", &master_pk)
            .await?;
        assert_eq!(account, predicted, "created where predicted");
        let account_c = Contract::new(account, ACCOUNT_IF.0, ACCOUNT_IF.1);
        let reported: Ed25519PublicKey = account_c.view(&ctx, "master_key", &(), None).await?;
        assert_eq!(reported, master_pk);

        // Fetch the network hash once; pass it into every account_tx call below.
        let network = network_hash(&ctx).await;

        // Master alone (weight 1, every threshold 1): add a second signer.
        let tx = account_tx(
            &ctx,
            &network,
            account,
            "set_signer",
            &(1u32, public_key(&SECOND_SEED), 1u32),
            1,
            &[(0, &master)],
            1,
        )
        .await;
        submit_ok(&ctx, tx).await;

        // Raise high to 2 (total weight is now 2). Still a weight-1 operation.
        let tx = account_tx(
            &ctx,
            &network,
            account,
            "set_thresholds",
            &(1u32, 1u32, 2u32),
            1,
            &[(0, &master)],
            2,
        )
        .await;
        submit_ok(&ctx, tx).await;

        // A high-threshold change signed by the master alone cannot clear the
        // claimed weight of 2: hogd refuses it before execution.
        let tx = account_tx(
            &ctx,
            &network,
            account,
            "set_thresholds",
            &(1u32, 1u32, 1u32),
            2,
            &[(0, &master)],
            3,
        )
        .await;
        match ctx.network().submit_raw(tx).await {
            Err(_) => {}
            Ok(hash) => {
                let receipt = ctx.network().await_receipt(hash).await;
                assert!(
                    receipt.is_err()
                        || !matches!(
                            receipt.unwrap().status,
                            groundhog_json_rpc_types::receipt::ExecStatus::Ok
                        ),
                    "an under-weight transaction must not execute"
                );
            }
        }

        // Claiming only 1 for the same change is refused by the account itself.
        let tx = account_tx(
            &ctx,
            &network,
            account,
            "set_thresholds",
            &(1u32, 1u32, 1u32),
            1,
            &[(0, &master)],
            4,
        )
        .await;
        let hash = ctx
            .network()
            .submit_raw(tx)
            .await
            .expect("admitted: weight 1 is satisfied");
        let receipt = ctx.network().await_receipt(hash).await.expect("receipt");
        assert!(
            !matches!(
                receipt.status,
                groundhog_json_rpc_types::receipt::ExecStatus::Ok
            ),
            "InsufficientAuthWeight"
        );

        // Both keys, claim 2: lands.
        let tx = account_tx(
            &ctx,
            &network,
            account,
            "set_thresholds",
            &(1u32, 1u32, 1u32),
            2,
            &[(0, &master), (1, &second)],
            5,
        )
        .await;
        submit_ok(&ctx, tx).await;

        // A medium op signed by the second signer alone.
        let me = ctx.address();
        let tx = account_tx(
            &ctx,
            &network,
            account,
            "payment",
            &(native.address(), me, 1u128),
            1,
            &[(1, &second)],
            6,
        )
        .await;
        submit_ok(&ctx, tx).await;

        println!("admin: account {account:?} created, two-signer threshold change landed");
        Ok(())
    })
}

#[tokio::test]
#[ignore = "needs GROUNDHOG_DEVNODE_BINARY and built stellar_account/stellar_account_factory artifacts in GROUNDHOG_TESTKIT_ARTIFACT_ROOT"]
async fn two_signer_threshold_change_on_a_live_node() {
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    config.dev_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }

    let scenario = Scenario::builder("stellar-account-live")
        .network(NetworkConfig::local(config))
        .artifact("stellar_account", artifact("stellar_account.rv32a"))
        .artifact(
            "stellar_account_factory",
            artifact("stellar_account_factory.rv32a"),
        )
        .build()
        .await
        .expect("local node starts");

    scenario
        .run_agents([admin()])
        .await
        .expect("agent runs to completion");
    scenario.stop().await.expect("clean teardown");
}
