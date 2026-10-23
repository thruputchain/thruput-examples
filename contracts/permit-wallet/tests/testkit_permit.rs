//! The permit flow on a live `hog-devnode`, driven by `thruput-testkit`.
//!
//! The same three contracts as `permit.rs`, exercised with real transactions.
//! An `admin` agent deploys the token, Alice's wallet and the relayer, funds
//! them, and mints Alice's balance to her wallet. A `spender` agent then
//! plays the submitter: it holds a permit Alice signed off-chain — with a key
//! that exists only in this test and never touches the chain — relays it, and
//! draws on the resulting allowance from its own account. The same permit
//! relayed a second time is refused. A further permit and then a signed clear
//! go through the same relayer, which reads each signed body to pick the
//! token method, so the allowance is re-granted and then revoked.
//!
//! It is `#[ignore]`d because it needs a devnode binary and built artifacts.
//! `scripts/permit-live.sh` wires up both. Roughly:
//!
//! ```text
//! cd thruput-examples
//! for c in erc20 permit-wallet permit-relayer; do thruput build -p "$c"; done
//! THRUPUT_DEVNODE_BINARY=/path/to/hog-devnode \
//! THRUPUT_TESTKIT_ARTIFACT_ROOT=/path/to/target/thruput \
//!     cargo test -p permit-wallet --test testkit_permit -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use ed25519_dalek::{Signer, SigningKey};
use permit_wallet::WalletRequest;
use thruput_domain_separator::SignedOp as SignedOpPreimage;
use thruput_erc20_permit_if::{DeleteAllowanceRequest, PermitRequest};
use thruput_json_rpc_client::DecodedResponse;
use thruput_json_rpc_client::types::requests::EmptyRequest;
use thruput_sdk::types::transaction::Uniquifier;
use thruput_sdk::types::{Ed25519PublicKey, Ed25519Signature};
use thruput_sdk::xdr::BytesM;
use thruput_signed_op_if::Operation;
use thruput_testkit::xdr::types::ContractAddress;
use thruput_testkit::{
    Agent, AgentContext, Contract, DeployOptions, LocalNetworkConfig, NetworkConfig, Result,
    Scenario, TestkitError, xdrs,
};

/// An alias to match the contracts' `Address` type.
type Address = ContractAddress;

// Interface identities (name, version) the contracts stamped at build time, as
// recorded in each `*.spec.json`; the testkit derives selectors from these.
const ERC20: (&str, &str) = ("ERC20", "0.1.65");
const WALLET: (&str, &str) = ("PermitWallet", "0.1.0");
const RELAYER: (&str, &str) = ("PermitRelayer", "0.1.0");

/// Alice's signing key. Off-chain only: the wallet stores the public half,
/// and no transaction is ever signed with it.
const ALICE_SEED: [u8; 32] = [0x11; 32];

const MINTED: i128 = 1_000;
const GRANTED: i128 = 250;

/// Blocks past the tip at signing time during which the permit stays valid.
const HORIZON: i64 = 1_000;

/// The first permit's nonce: any value the pair `(nonce, expiry)` has not
/// been consumed under at the wallet. Later operations count up from it.
const NONCE: u64 = 7;

/// Native storage tokens the admin grants each contract that writes
/// storage: the wallet records consumed permits, the token records balances
/// and allowances. The relayer keeps no state and needs none.
const CONTRACT_FUNDING: i128 = 1_000_000_000;

fn alice_public_key() -> Ed25519PublicKey {
    Ed25519PublicKey::from(
        SigningKey::from_bytes(&ALICE_SEED)
            .verifying_key()
            .to_bytes(),
    )
}

/// The addresses the spender needs, sent to it over the mailbox.
#[derive(Debug, Clone, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "thruput_testkit::xdrs")]
struct PermitConfig {
    token: Address,
    wallet: Address,
    relayer: Address,
}

/// The SDK's view of an address: the testkit and the SDK each re-export the
/// protocol's `ContractAddress`, so this is a copy of the same 32 bytes.
fn sdk_address(address: &Address) -> thruput_sdk::ContractAddress {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(address.as_ref());
    thruput_sdk::ContractAddress::from(bytes)
}

/// The network hash the node binds into every signature, read over RPC.
async fn network_hash(ctx: &AgentContext) -> thruput_sdk::types::NetworkHash {
    let client = ctx
        .network()
        .client()
        .expect("a local network has an RPC client");
    let DecodedResponse::Known(info) = client
        .get_network_info(EmptyRequest {})
        .await
        .expect("getNetworkInfo answers on a live node")
    else {
        panic!("unsupported network identity")
    };
    thruput_sdk::types::NetworkHash::new(info.network_hash.0)
}

/// What Alice does off-chain: build the preimage from the network, her
/// wallet, the `(nonce, expiry)` uniquifier and the body's `TYPE_DEF`, then
/// sign it. Deterministic, so the same inputs reproduce the same bytes. The
/// body is the wallet's own request type, naming the grant it should mint.
fn sign_request(
    network: &thruput_sdk::types::NetworkHash,
    wallet: &Address,
    nonce: u64,
    expiry: i64,
    body: &WalletRequest,
) -> (Operation, Ed25519Signature) {
    let key = SigningKey::from_bytes(&ALICE_SEED);
    let expiry = thruput_sdk::BlockHeight::from(expiry);
    let preimage = SignedOpPreimage {
        network: network.clone(),
        verifying_contract: sdk_address(wallet),
        uniquifier: Uniquifier {
            block_expiry_height: expiry.clone(),
            nonce,
        },
        body,
    }
    .preimage()
    .expect("encoding the signed-operation preimage");

    let op = Operation {
        block_expiry_height: expiry,
        nonce,
        body: BytesM(thruput_sdk::xdr::cxs::encode(body).expect("encoding the body")),
    };
    (op, Ed25519Signature::from(key.sign(&preimage).to_bytes()))
}

/// As admin: deploy and fund the token and Alice's wallet, deploy the
/// relayer, initialize both stateful contracts, and mint Alice's balance to
/// her wallet.
async fn deploy_and_init(ctx: &mut AgentContext) -> Result<PermitConfig> {
    let me = ctx.address();

    let token = Contract::new(
        ctx.deploy_artifact("erc20", DeployOptions::funded(CONTRACT_FUNDING as u128))
            .await?
            .address,
        ERC20.0,
        ERC20.1,
    );
    let wallet = Contract::new(
        ctx.deploy_artifact(
            "permit_wallet",
            DeployOptions::funded(CONTRACT_FUNDING as u128),
        )
        .await?
        .address,
        WALLET.0,
        WALLET.1,
    );
    let relayer = ctx
        .deploy_artifact(
            "permit_relayer",
            DeployOptions::funded(CONTRACT_FUNDING as u128),
        )
        .await?
        .address;

    token.call(ctx, "initialize", &me).await?;
    // The admin can rotate Alice's key; Alice's key authorizes permits.
    //
    // Deploying and initializing in separate transactions is fine on this
    // private devnode, where nothing else can reach the wallet in between,
    // but it is not the pattern for a public network: there, deploy through
    // a contract frame that calls `initialize` before it ends (see the
    // wallet's `initialize` docs), since a raw deploy transaction cannot
    // also make a call.
    wallet
        .call(ctx, "initialize", &(me, alice_public_key()))
        .await?;
    token.call(ctx, "mint", &(wallet.address(), MINTED)).await?;

    Ok(PermitConfig {
        token: token.address(),
        wallet: wallet.address(),
        relayer,
    })
}

fn admin() -> Agent {
    Agent::new("admin", |mut ctx| async move {
        let cfg = deploy_and_init(&mut ctx).await?;

        // The spender announces itself, then gets the addresses.
        let spender = ctx
            .recv_from::<Address>("spender")
            .await
            .expect("bug: spender closed before greeting")?
            .body;
        ctx.send("spender", &cfg)?;

        // Once the spender is done, Alice's balance has moved: the permit was
        // honored without Alice ever submitting a transaction.
        ctx.recv_from::<()>("spender")
            .await
            .expect("bug: spender closed before finishing")?;
        let token = Contract::new(cfg.token, ERC20.0, ERC20.1);
        let wallet_balance: i128 = token
            .view(&ctx, "get_balance_of", &cfg.wallet, None)
            .await?;
        let spender_balance: i128 = token.view(&ctx, "get_balance_of", &spender, None).await?;
        assert_eq!(wallet_balance, MINTED - GRANTED, "the wallet was debited");
        assert_eq!(spender_balance, GRANTED, "the spender was credited");
        println!("admin: wallet holds {wallet_balance}, spender holds {spender_balance}");
        Ok(())
    })
}

/// The spender agent: the submitter of Alice's permit, and the one it names.
fn spender() -> Agent {
    Agent::new("spender", |mut ctx| async move {
        let me = ctx.address();
        ctx.send("admin", &me)?;
        let cfg = ctx
            .recv_from::<PermitConfig>("admin")
            .await
            .expect("bug: admin closed before sending addresses")?
            .body;
        let token = Contract::new(cfg.token, ERC20.0, ERC20.1);
        let relayer = Contract::new(cfg.relayer, RELAYER.0, RELAYER.1);

        // Alice signs off-chain: `GRANTED` units of the token, spendable by
        // us, valid for `HORIZON` blocks. In practice this arrives from Alice
        // out of band; here we hold her test-only key.
        let network = network_hash(&ctx).await;
        let expiry = *ctx.network().chain_tip().await?.block_height + HORIZON;
        let request = WalletRequest::Permit(PermitRequest {
            token: sdk_address(&cfg.token),
            spender: sdk_address(&me),
            amount: GRANTED,
        });
        let (op, signature) = sign_request(&network, &cfg.wallet, NONCE, expiry, &request);

        // Relay it: the wallet verifies and mints, the token records the
        // allowance, all in the relayer's one frame.
        relayer
            .call(&ctx, "relay", &(cfg.wallet, cfg.token, op, signature))
            .await?;
        let allowance: i128 = token
            .view(&ctx, "allowance", &(cfg.wallet, me), None)
            .await?;
        assert_eq!(
            allowance, GRANTED,
            "the relayed permit recorded an allowance"
        );

        // Draw on it from our own account, as any spender would.
        token
            .call(&ctx, "transfer_from", &(cfg.wallet, me, GRANTED))
            .await?;
        let balance: i128 = token.view(&ctx, "get_balance_of", &me, None).await?;
        assert_eq!(balance, GRANTED, "transfer_from moved the granted amount");

        // The same bytes again: the wallet already consumed this
        // `(nonce, expiry)` pair, so the relayer's frame reverts and the
        // allowance does not grow.
        let (op, signature) = sign_request(&network, &cfg.wallet, NONCE, expiry, &request);
        match relayer
            .call(&ctx, "relay", &(cfg.wallet, cfg.token, op, signature))
            .await
        {
            Err(TestkitError::Reverted { .. }) => {}
            other => panic!("a replayed permit should revert, got {other:?}"),
        }
        let allowance: i128 = token
            .view(&ctx, "allowance", &(cfg.wallet, me), None)
            .await?;
        assert_eq!(allowance, 0, "the replay added nothing");

        // A fresh permit under the next nonce is honored again, and the
        // relayer routes it by its body to `increase_allowance_signed`.
        let (op, signature) = sign_request(&network, &cfg.wallet, NONCE + 1, expiry, &request);
        relayer
            .call(&ctx, "relay", &(cfg.wallet, cfg.token, op, signature))
            .await?;
        let allowance: i128 = token
            .view(&ctx, "allowance", &(cfg.wallet, me), None)
            .await?;
        assert_eq!(
            allowance, GRANTED,
            "a second permit re-granted the allowance"
        );

        // Alice takes it back with a signed clear. The same relayer carries
        // it, reads the body, and hands the grant to `delete_allowance_signed`.
        let clear = WalletRequest::DeleteAllowance(DeleteAllowanceRequest {
            token: sdk_address(&cfg.token),
            spender: sdk_address(&me),
        });
        let (op, signature) = sign_request(&network, &cfg.wallet, NONCE + 2, expiry, &clear);
        relayer
            .call(&ctx, "relay", &(cfg.wallet, cfg.token, op, signature))
            .await?;
        let allowance: i128 = token
            .view(&ctx, "allowance", &(cfg.wallet, me), None)
            .await?;
        assert_eq!(allowance, 0, "the relayed clear revoked the allowance");
        match token
            .call(&ctx, "transfer_from", &(cfg.wallet, me, 1i128))
            .await
        {
            Err(TestkitError::Reverted { .. }) => {}
            other => panic!("drawing on a cleared allowance should revert, got {other:?}"),
        }

        println!(
            "spender: permit relayed, {GRANTED} drawn, replay refused, re-granted, then cleared"
        );
        ctx.send("admin", &())?;
        Ok(())
    })
}

#[tokio::test]
#[ignore = "needs THRUPUT_DEVNODE_BINARY and built erc20/permit_wallet/permit_relayer artifacts in THRUPUT_TESTKIT_ARTIFACT_ROOT"]
async fn permit_signed_off_chain_relayed_on_chain() {
    let Ok(root) = std::env::var("THRUPUT_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!(
            "skipping: set THRUPUT_TESTKIT_ARTIFACT_ROOT to a directory with the built \
             erc20/permit_wallet/permit_relayer artifacts (see module docs)"
        );
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    // The admin funds the contracts it deploys (see CONTRACT_FUNDING).
    config.initial_account_tokens = 100_000_000_000;
    if let Ok(bin) = std::env::var("THRUPUT_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }
    if std::env::var("RUST_LOG").is_ok() {
        config.log_level = Some(thruput_testkit::LogLevel::Info);
    }

    let scenario = Scenario::builder("permit-live")
        .network(NetworkConfig::local(config))
        .artifact("erc20", artifact("erc20.rv32a"))
        .artifact("permit_wallet", artifact("permit_wallet.rv32a"))
        .artifact("permit_relayer", artifact("permit_relayer.rv32a"))
        .build()
        .await
        .expect("local node starts with the permit artifacts registered");

    scenario
        .run_agents([admin(), spender()])
        .await
        .expect("agents run to completion");

    scenario.stop().await.expect("clean teardown");
}
