//! Shared harness for RPC integration tests.
//!
//! These tests run against a *live* node, unlike the executor-backed tests.
//! They are driven by:
//!
//! ```bash
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//!     groundhog test --integration
//! ```
//!
//! `groundhog test --integration` builds the contract to a guest binary, starts
//! an ephemeral hog-devnode, deploys the contract with `dev-0`, and then runs
//! the test with the following environment set:
//!
//!   - `GROUNDHOG_RPC_URL`          — JSON-RPC endpoint of the ephemeral node
//!   - `GROUNDHOG_CONTRACT_ADDRESS` — address the contract was deployed to
//!   - `GROUNDHOG_DEFAULT_KEY`      — `dev-0`
//!   - `GROUNDHOG_RUNTIME_MANIFEST` — path to the node's runtime manifest
//!
//! [`Harness`] holds everything needed to exercise a contract the way a client
//! would: it signs and submits transactions through the bootstrapped `dev-0`
//! wallet, then hands back each transaction's receipt. The contract-specific
//! method calls and return decoding live in each contract's own test.

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

/// Legacy fallback for the dev wallet's `do_action` entrypoint (from the
/// dev-wallet guest-binary exports), used only when the runtime manifest does
/// not advertise a parseable entrypoint.
const WALLET_DO_ACTION_ENTRYPOINT: [u8; 8] = 0x1984_6D75_0FAD_81D6_u64.to_be_bytes();

/// Source labels for the resolved wallet `do_action` entrypoint, surfaced in
/// failure diagnostics to show whether it came from the manifest or the
/// baked-in fallback.
const WALLET_ENTRYPOINT_SOURCE_RUNTIME_MANIFEST: &str = "runtime_manifest";
const WALLET_ENTRYPOINT_SOURCE_LEGACY_DEFAULT: &str = "legacy_default";

/// How long to wait for a submitted transaction's receipt.
const RECEIPT_POLL_ATTEMPTS: u32 = 30;
const RECEIPT_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Everything needed to sign and submit calls against the live node, bound to a
/// single deployed contract's interface and version.
pub struct Harness {
    rpc_url: String,
    contract: ContractAddress,
    /// Interface name and version of the deployed contract, used to derive
    /// entrypoint IDs for the methods under test.
    interface: &'static str,
    version: &'static str,
    signer: LocalSigner,
    /// dev-0's wallet contract address (the transaction caller).
    wallet: ContractAddress,
    /// The wallet's resolved `do_action` entrypoint, and a label recording
    /// whether it came from the runtime manifest or the legacy fallback.
    wallet_entrypoint: ContractEntrypointID,
    wallet_entrypoint_source: &'static str,
    /// Runtime manifest, retained to resolve additional bootstrap wallets.
    manifest: RuntimeManifest,
    /// Monotonic transaction nonce.
    nonce: AtomicU64,
}

impl Harness {
    /// Build a harness from the environment `groundhog test --integration` sets,
    /// bound to the given contract `interface` name and `version` (used to
    /// derive the entrypoint ID of each method under test).
    pub fn from_env(interface: &'static str, version: &'static str) -> Self {
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

        // Prefer the `do_action` entrypoint the node advertises in its manifest,
        // falling back to the baked-in default if the manifest's value can't be
        // parsed. The source is recorded for failure diagnostics.
        let (wallet_entrypoint, wallet_entrypoint_source) = resolve_wallet_entrypoint(&manifest);

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
            interface,
            version,
            signer,
            wallet,
            wallet_entrypoint,
            wallet_entrypoint_source,
            manifest,
            nonce: AtomicU64::new(seed),
        }
    }

    /// dev-0's wallet address — the caller of every transaction this harness
    /// submits.
    pub fn wallet(&self) -> ContractAddress {
        self.wallet
    }

    /// Resolve the wallet address for `dev-{index}` from the runtime manifest.
    pub fn dev_wallet(&self, index: u32) -> ContractAddress {
        wallet_address(&self.manifest, index)
    }

    /// Sign and submit a call to `method` with the given calldata, wait for the
    /// receipt, and assert the transaction executed successfully.
    pub async fn invoke(&self, method: &str, calldata: Vec<u8>) -> TransactionReceipt {
        let client = self.client();

        let tip = client.chain_tip().await.expect("chainTip");
        let block_expiry_height = (*tip.height).saturating_add(1_000);

        let tx = build_dev_wallet_do_action_transaction(BuildDevWalletDoActionTransaction {
            wallet_address: self.wallet,
            wallet_entrypoint: self.wallet_entrypoint,
            target_address: self.contract,
            target_entrypoint: self.entrypoint_id(method),
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
                        "{}",
                        self.failure_diagnostics(method, &receipt)
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

    /// Derive the 8-byte entrypoint ID for one of the contract's methods.
    fn entrypoint_id(&self, method: &str) -> ContractEntrypointID {
        let sig = NormalizedMethodSignature::new(method);
        contract_entrypoint_id(Some(self.interface), self.version, &sig)
    }

    /// Render the call context a failed call needs for debugging, mirroring the
    /// diagnostics the `groundhog call` CLI prints: the wallet and its resolved
    /// entrypoint (with source), the target contract/method/entrypoint, and the
    /// receipt's status and abort payload. The receipt we already hold is our
    /// stand-in for the CLI's `groundhog_dev_getTransactionDetail` dump.
    fn failure_diagnostics(&self, method: &str, receipt: &TransactionReceipt) -> String {
        let abort_data = receipt
            .abort_data
            .as_ref()
            .map_or_else(|| "none".to_owned(), |data| format_hex_bytes(&data.0));
        format!(
            "`{method}` did not succeed\n  \
             status: {:?}\n  \
             wallet: {} entrypoint={} source={}\n  \
             target: {} method=`{method}` entrypoint={}\n  \
             abort_data: {abort_data}",
            receipt.status,
            format_contract_address(&self.wallet),
            format_entrypoint_id(self.wallet_entrypoint),
            self.wallet_entrypoint_source,
            format_contract_address(&self.contract),
            format_entrypoint_id(self.entrypoint_id(method)),
        )
    }
}

/// Encode a method's arguments into calldata (the contract serialization the
/// node expects: each argument's XDR encoding, concatenated).
pub fn encode<T: xdrs::WriteXDR>(args: &T) -> Vec<u8> {
    xdrs::cxs::encode(args).expect("encode calldata")
}

/// Decode a transaction receipt's return value as `T`.
pub fn decode_return<T>(receipt: &TransactionReceipt) -> T
where
    T: for<'a> xdrs::ReadXDR<'a>,
{
    let data = receipt
        .return_data
        .as_ref()
        .expect("expected a return value");
    xdrs::cxs::decode(data.0.as_slice()).expect("decode return value")
}

/// Resolve the dev-wallet `do_action` entrypoint, preferring the value the
/// runtime manifest advertises and falling back to the baked-in legacy default
/// when the manifest's field can't be parsed. Returns the entrypoint together
/// with a label describing which source won.
fn resolve_wallet_entrypoint(manifest: &RuntimeManifest) -> (ContractEntrypointID, &'static str) {
    match manifest.bootstrap.dev_wallet.do_action_entrypoint_id() {
        Ok(id) => (id, WALLET_ENTRYPOINT_SOURCE_RUNTIME_MANIFEST),
        Err(_) => (
            ContractEntrypointID::from(WALLET_DO_ACTION_ENTRYPOINT),
            WALLET_ENTRYPOINT_SOURCE_LEGACY_DEFAULT,
        ),
    }
}

fn format_entrypoint_id(entrypoint: ContractEntrypointID) -> String {
    format!("0x{}", hex::encode(entrypoint.into_inner()))
}

fn format_contract_address(address: &ContractAddress) -> String {
    format!("0x{}", hex::encode(address.as_ref()))
}

fn format_hex_bytes(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
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
