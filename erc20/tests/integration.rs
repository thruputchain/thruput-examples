//! RPC integration test for the `erc20` contract.
//!
//! This runs against a *live* node, unlike the executor-backed WASM tests.
//! It is driven by:
//!
//! ```bash
//! GROUNDHOG_HOG_DEVNODE_BINARY=/path/to/hog-devnode \
//!     groundhog test --integration --hogd-protocol hogp/7874f05decb9
//! ```
//!
//! `groundhog test --integration` builds the contract to WASM, starts an
//! ephemeral hog-devnode, deploys the contract with `dev-0`, and then runs this
//! test with the following environment set:
//!
//!   - `GROUNDHOG_RPC_URL`          — JSON-RPC endpoint of the ephemeral node
//!   - `GROUNDHOG_CONTRACT_ADDRESS` — address the contract was deployed to
//!   - `GROUNDHOG_DEFAULT_KEY`      — `dev-0`
//!   - `GROUNDHOG_RUNTIME_MANIFEST` — path to the node's runtime manifest
//!
//! The test exercises the contract the way a client would: it signs and submits
//! transactions through the bootstrapped `dev-0` wallet, then reads the results
//! back from each transaction's receipt.

use groundhog_contract_util::{NormalizedMethodSignature, contract_entrypoint_id};
use groundhog_json_rpc_client::{GroundhogApiClient, HttpClientBuilder};
use groundhog_json_rpc_types::receipt::{ExecStatus, TransactionReceipt};
use groundhog_json_rpc_types::runtime_manifest::RuntimeManifest;
use groundhog_signing::{
    BuildDevWalletDoActionTransaction, DEFAULT_TX_GAS_LIMIT, LocalSigner, SignTransactionParams,
    build_dev_wallet_do_action_transaction, derive_default_dev_account_signer,
    sign_and_encode_transaction_hex,
};
use groundhog_xdr::contract::ContractEntrypointID;
use groundhog_xdr::types::ContractAddress;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const INTERFACE: &str = "ERC20";
const VERSION: &str = "0.1.3";

/// The dev wallet's `do_action` entrypoint (from the dev-wallet WASM exports).
const WALLET_DO_ACTION_ENTRYPOINT: [u8; 8] = 0x1984_6D75_0FAD_81D6_u64.to_be_bytes();

/// How long to wait for a submitted transaction's receipt.
const RECEIPT_POLL_ATTEMPTS: u32 = 30;
const RECEIPT_POLL_INTERVAL: Duration = Duration::from_secs(1);

#[tokio::test]
async fn erc20_lifecycle_over_rpc() {
    let h = Harness::from_env();

    // The bootstrapped dev-0 wallet is the caller of every transaction below,
    // so it becomes the token administrator and the source of transfers.
    let admin = h.wallet;
    let recipient = h.peer_wallet;

    // Fresh deploy: total supply starts at zero (this also confirms the
    // contract is reachable before we initialize it).
    h.initialize(&admin).await;
    assert_eq!(h.total_supply().await, 0, "fresh contract has no supply");

    // Mint to the administrator and confirm supply and balance move together.
    h.mint(&admin, 1_000).await;
    assert_eq!(h.total_supply().await, 1_000, "supply reflects the mint");
    assert_eq!(
        h.balance_of(&admin).await,
        1_000,
        "admin holds the minted tokens"
    );

    // Transfer some away; both balances should update, supply should not.
    h.transfer(&recipient, 400).await;
    assert_eq!(h.balance_of(&admin).await, 600, "admin balance debited");
    assert_eq!(
        h.balance_of(&recipient).await,
        400,
        "recipient balance credited"
    );
    assert_eq!(
        h.total_supply().await,
        1_000,
        "transfers do not change supply"
    );
}

/// Everything needed to sign and submit `erc20` calls against the live node.
struct Harness {
    rpc_url: String,
    contract: ContractAddress,
    signer: LocalSigner,
    /// dev-0's wallet contract address (the transaction caller).
    wallet: ContractAddress,
    /// A second dev wallet address, used as a transfer recipient.
    peer_wallet: ContractAddress,
    /// Monotonic transaction nonce.
    nonce: AtomicU64,
}

impl Harness {
    fn from_env() -> Self {
        let rpc_url = env("GROUNDHOG_RPC_URL");
        let contract = parse_address(&env("GROUNDHOG_CONTRACT_ADDRESS"));

        let manifest_path = env("GROUNDHOG_RUNTIME_MANIFEST");
        let manifest: RuntimeManifest = serde_json::from_str(
            &std::fs::read_to_string(&manifest_path)
                .unwrap_or_else(|e| panic!("reading runtime manifest {manifest_path}: {e}")),
        )
        .expect("parsing runtime manifest");

        // `dev-0`'s signing key is derived deterministically from the well-known
        // seed; its on-chain wallet address comes from the manifest.
        let signer = derive_default_dev_account_signer(0);
        let wallet = wallet_address(&manifest, 0);
        let peer_wallet = wallet_address(&manifest, 1);

        // Seed the nonce from the wall clock so reruns against the same node
        // don't collide with earlier transactions.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| u64::try_from(d.as_nanos()).ok())
            .unwrap_or(1);

        Self {
            rpc_url,
            contract,
            signer,
            wallet,
            peer_wallet,
            nonce: AtomicU64::new(seed),
        }
    }

    async fn initialize(&self, administrator: &ContractAddress) {
        self.invoke("initialize", encode(administrator)).await;
    }

    async fn mint(&self, receiver: &ContractAddress, amount: u128) {
        self.invoke("mint", encode(&(*receiver, amount))).await;
    }

    async fn transfer(&self, receiver: &ContractAddress, amount: u128) {
        self.invoke("transfer", encode(&(*receiver, amount))).await;
    }

    async fn total_supply(&self) -> u128 {
        let receipt = self.invoke("total_supply", Vec::new()).await;
        decode_amount(&receipt)
    }

    async fn balance_of(&self, owner: &ContractAddress) -> u128 {
        let receipt = self.invoke("get_balance_of", encode(owner)).await;
        decode_amount(&receipt)
    }

    /// Sign and submit a call to `method` with the given calldata, wait for the
    /// receipt, and assert the transaction executed successfully.
    async fn invoke(&self, method: &str, calldata: Vec<u8>) -> TransactionReceipt {
        let client = self.client();

        let tip = client.chain_tip().await.expect("chainTip");
        let block_expiry_height = i64::from(*tip.height).saturating_add(1_000);

        let tx = build_dev_wallet_do_action_transaction(BuildDevWalletDoActionTransaction {
            wallet_address: self.wallet,
            wallet_entrypoint: ContractEntrypointID::from(WALLET_DO_ACTION_ENTRYPOINT),
            target_address: self.contract,
            target_entrypoint: entrypoint_id(method),
            target_calldata: &calldata,
            gas_limit: DEFAULT_TX_GAS_LIMIT,
            target_gas_limit: DEFAULT_TX_GAS_LIMIT,
            block_expiry_height,
            nonce: self.nonce.fetch_add(1, Ordering::Relaxed),
        })
        .expect("build dev-wallet transaction");

        let tx_hex =
            sign_and_encode_transaction_hex(tx, &self.signer, SignTransactionParams::default())
                .expect("sign transaction");

        let tx_hash = client
            .send_raw_transaction(tx_hex)
            .await
            .unwrap_or_else(|e| panic!("sendRawTransaction for `{method}`: {e}"));

        for _ in 0..RECEIPT_POLL_ATTEMPTS {
            match client.get_transaction_receipt(tx_hash).await {
                Ok(Some(receipt)) => {
                    assert!(
                        matches!(receipt.status, ExecStatus::Ok),
                        "`{method}` did not succeed: {:?}",
                        receipt.status
                    );
                    return receipt;
                }
                Ok(None) => tokio::time::sleep(RECEIPT_POLL_INTERVAL).await,
                Err(e) => panic!("getTransactionReceipt for `{method}`: {e}"),
            }
        }

        panic!("`{method}` receipt did not arrive within {RECEIPT_POLL_ATTEMPTS}s");
    }

    fn client(&self) -> impl GroundhogApiClient {
        HttpClientBuilder::default()
            .build(&self.rpc_url)
            .expect("build JSON-RPC client")
    }
}

/// Derive the 8-byte entrypoint ID for an `ERC20` method
fn entrypoint_id(method: &str) -> ContractEntrypointID {
    let sig = NormalizedMethodSignature::new(method);
    let id = contract_entrypoint_id(Some(INTERFACE), VERSION, &sig);
    let bytes: [u8; 8] = id.as_ref()[..8]
        .try_into()
        .expect("entrypoint ID is at least 8 bytes");
    ContractEntrypointID::from(bytes)
}

/// Encode a method's arguments into calldata (the contract serialization the
/// node expects: each argument's XDR encoding, concatenated).
fn encode<T: xdrs::WriteXDR>(args: &T) -> Vec<u8> {
    xdrs::cxs::encode(args).expect("encode calldata")
}

/// Decode an `Amount` (u128) return value from a transaction receipt.
fn decode_amount(receipt: &TransactionReceipt) -> u128 {
    let data = receipt
        .return_data
        .as_ref()
        .expect("expected a return value");
    xdrs::cxs::decode::<u128>(data.0.as_slice()).expect("decode u128 return value")
}

/// Resolve the wallet address for `dev-{index}` from the runtime manifest.
fn wallet_address(manifest: &RuntimeManifest, index: u32) -> ContractAddress {
    manifest
        .bootstrap_accounts
        .iter()
        .find(|account| account.index == index)
        .unwrap_or_else(|| panic!("runtime manifest has no bootstrap account dev-{index}"))
        .wallet_address
        .0
}

fn parse_address(hex_str: &str) -> ContractAddress {
    let stripped = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    let bytes = hex::decode(stripped)
        .unwrap_or_else(|e| panic!("contract address `{hex_str}` is not valid hex: {e}"));
    let bytes: [u8; 32] = bytes
        .try_into()
        .unwrap_or_else(|_| panic!("contract address `{hex_str}` is not 32 bytes"));
    ContractAddress::from(bytes)
}

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| {
        panic!("{key} must be set (run this test via `groundhog test --integration`)")
    })
}
