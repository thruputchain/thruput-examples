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
//! native account, then hands back each transaction's receipt. The
//! contract-specific method calls and return decoding live in each contract's
//! own test.

use groundhog_contract_util::{NormalizedMethodSignature, contract_entrypoint_id};
use groundhog_json_rpc_client::{GroundhogApiClient, HttpClient, HttpClientBuilder};
use groundhog_json_rpc_types::block::{BlockInfo, ChainTip};
use groundhog_json_rpc_types::events::{EventPage, EventQuery};
use groundhog_json_rpc_types::hex::{Hex0x, HexBytes};
use groundhog_json_rpc_types::receipt::{ExecStatus, TransactionReceipt};
use groundhog_json_rpc_types::runtime_manifest::{RuntimeManifest, parse_runtime_manifest};
use groundhog_json_rpc_types::transaction::{TransactionStatus, TxHash};
use groundhog_json_rpc_types::view::{RootInvocationOutput, ViewRequest, ViewResponse};
use groundhog_signing::default_wallet::{
    BuildDefaultWalletCallTransaction, DEFAULT_WALLET_EXECUTE_ENTRYPOINT,
    build_default_wallet_call_transaction, decode_default_wallet_call_return,
};
use groundhog_signing::{
    DEFAULT_PUBKEY_ACCOUNT_NONCE, DEFAULT_TX_GAS_LIMIT, LocalSigner, PubkeyAccount,
    SignTransactionParams, Signer, derive_default_dev_account_signer,
    sign_and_encode_transaction_hex,
};
use groundhog_xdr::contract::ContractEntrypointID;
use groundhog_xdr::types::{ContractAddress, NetworkHash};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Default transaction expiry and receipt polling configuration.
const DEFAULT_EXPIRY_OFFSET: i64 = 1_000;
const DEFAULT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(30);
const RECEIPT_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How a transaction's expiry height is selected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransactionExpiry {
    /// Add this many blocks to the chain tip observed before submission.
    Offset(i64),
    /// Use this exact block height.
    Absolute(i64),
}

/// Per-invocation transaction and receipt polling settings.
#[derive(Clone, Copy, Debug)]
pub struct InvocationOptions {
    /// Gas available to the outer native-account transaction.
    pub outer_transaction_gas_limit: u64,
    /// Gas available to the target contract call.
    pub target_call_gas_limit: u64,
    /// Transaction expiry, relative to the current tip or absolute.
    pub expiry: TransactionExpiry,
    /// Maximum time to wait for a terminal result.
    pub receipt_timeout: Duration,
    /// Delay between receipt and status checks.
    pub receipt_poll_interval: Duration,
}

impl Default for InvocationOptions {
    fn default() -> Self {
        Self {
            outer_transaction_gas_limit: DEFAULT_TX_GAS_LIMIT,
            target_call_gas_limit: DEFAULT_TX_GAS_LIMIT,
            expiry: TransactionExpiry::Offset(DEFAULT_EXPIRY_OFFSET),
            receipt_timeout: DEFAULT_RECEIPT_TIMEOUT,
            receipt_poll_interval: RECEIPT_POLL_INTERVAL,
        }
    }
}

/// Terminal or currently observed result of submitting an invocation.
#[derive(Debug)]
pub enum SubmissionOutcome {
    /// The transaction committed and did not deterministically fail.
    Committed(TransactionReceipt),
    /// The transaction committed but did not execute successfully.
    Failed(TransactionReceipt),
    /// The receipt timeout elapsed while the transaction could still commit.
    Pending { tx_hash: TxHash },
    /// The transaction did not commit before its expiry height.
    Expired { tx_hash: TxHash },
    /// The scheduler rejected the transaction.
    Invalid { tx_hash: TxHash, reason: String },
}

/// Failure to build, submit, or query an invocation.
#[derive(Debug)]
pub enum SubmissionError {
    BuildClient(String),
    Rpc {
        operation: &'static str,
        code: Option<i32>,
        message: String,
        tx_hash: Option<TxHash>,
    },
    BuildTransaction(String),
    SignTransaction(String),
}

impl std::fmt::Display for SubmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BuildClient(message) => write!(f, "build JSON-RPC client: {message}"),
            Self::Rpc {
                operation,
                code: _,
                message,
                tx_hash,
            } => {
                write!(f, "{operation}: {message}")?;
                if let Some(tx_hash) = tx_hash {
                    write!(f, " (transaction {tx_hash:?})")?;
                }
                Ok(())
            }
            Self::BuildTransaction(message) => write!(f, "build transaction: {message}"),
            Self::SignTransaction(message) => write!(f, "sign transaction: {message}"),
        }
    }
}

impl std::error::Error for SubmissionError {}

/// Everything needed to sign and submit calls against the live node, bound to a
/// single deployed contract's interface and version.
pub struct Harness {
    client: Result<HttpClient, String>,
    contract: ContractAddress,
    /// Interface name and version of the deployed contract, used to derive
    /// entrypoint IDs for the methods under test.
    interface: &'static str,
    version: &'static str,
    signer: LocalSigner,
    /// dev-0's native account: the transaction caller. Its address is the
    /// nonce-zero pubkey account of the signer, as the manifest confirms.
    account: PubkeyAccount,
    wallet: ContractAddress,
    /// Runtime manifest, retained to resolve additional bootstrap accounts.
    manifest: RuntimeManifest,
    network_hash: NetworkHash,
    /// Monotonic transaction nonce.
    nonce: AtomicU64,
}

impl Harness {
    /// Build a harness from the environment `groundhog test --integration` sets,
    /// bound to the given contract `interface` name and `version` (used to
    /// derive the entrypoint ID of each method under test).
    pub fn from_env(interface: &'static str, version: &'static str) -> Self {
        let rpc_url = env("GROUNDHOG_RPC_URL");
        let client = HttpClientBuilder::default()
            .build(&rpc_url)
            .map_err(|e| format!("{rpc_url}: {e}"));
        let contract = parse_address(&env("GROUNDHOG_CONTRACT_ADDRESS"));

        let manifest_path = env("GROUNDHOG_RUNTIME_MANIFEST");
        let manifest_json = std::fs::read(&manifest_path)
            .unwrap_or_else(|e| panic!("reading runtime manifest {manifest_path}: {e}"));
        let manifest = parse_runtime_manifest(&manifest_json)
            .unwrap_or_else(|e| panic!("parsing runtime manifest {manifest_path}: {e}"));

        // `dev-0`'s signing key is derived deterministically from the well-known
        // seed. Its native account is the nonce-zero pubkey account of that
        // key; the manifest's bootstrap entry must agree, or the node was
        // bootstrapped from a different seed than this harness derives from.
        let signer = derive_default_dev_account_signer(0);
        let account = PubkeyAccount::new(signer.public_key(), DEFAULT_PUBKEY_ACCOUNT_NONCE);
        let wallet = account.address();
        let advertised = wallet_address(&manifest, 0);
        assert_eq!(
            wallet,
            advertised,
            "runtime manifest's dev-0 address {} is not the nonce-zero native account {} of the default dev-0 key",
            format_contract_address(&advertised),
            format_contract_address(&wallet),
        );
        let network_hash = manifest.network_hash.to_network_hash();

        // Seed the nonce from the wall clock so reruns against the same node
        // don't collide with earlier transactions.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| u64::try_from(d.as_nanos()).ok())
            .unwrap_or(1);

        Self {
            client,
            contract,
            interface,
            version,
            signer,
            account,
            wallet,
            manifest,
            network_hash,
            nonce: AtomicU64::new(seed),
        }
    }

    /// Point this harness at a different contract.
    ///
    /// `from_env` binds to the contract `groundhog test --integration` deployed,
    /// which is the only one most tests want.  A system contract -- the native
    /// token, say -- lives at a fixed address that no test deploys, so reaching
    /// it means naming it, along with the interface and version its entrypoint
    /// IDs derive from.
    pub fn retarget(
        mut self,
        contract: ContractAddress,
        interface: &'static str,
        version: &'static str,
    ) -> Self {
        self.contract = contract;
        self.interface = interface;
        self.version = version;
        self
    }

    fn client(&self) -> Result<&HttpClient, SubmissionError> {
        self.client
            .as_ref()
            .map_err(|message| SubmissionError::BuildClient(message.clone()))
    }

    /// dev-0's native account address — the caller of every transaction this
    /// harness submits.
    pub fn wallet(&self) -> ContractAddress {
        self.wallet
    }

    /// Address of the deployed contract this harness targets.
    pub fn contract(&self) -> ContractAddress {
        self.contract
    }

    /// Resolve the native account address for `dev-{index}` from the runtime
    /// manifest.
    pub fn dev_wallet(&self, index: u32) -> ContractAddress {
        wallet_address(&self.manifest, index)
    }

    /// Execute a read-only contract call against the latest committed snapshot.
    pub async fn view(
        &self,
        method: &str,
        calldata: Vec<u8>,
    ) -> Result<ViewResponse, SubmissionError> {
        self.client()?
            .view(ViewRequest {
                contract: Hex0x(self.contract),
                entrypoint: HexBytes(self.entrypoint_id(method).into_inner().to_vec()),
                calldata: HexBytes(calldata),
                caller: Some(Hex0x(self.wallet)),
                gas_limit: None,
            })
            .await
            .map_err(|e| rpc_error("view", e, None))
    }

    /// Read the current committed block height and hash.
    pub async fn chain_tip(&self) -> Result<ChainTip, SubmissionError> {
        self.client()?
            .chain_tip()
            .await
            .map_err(|e| rpc_error("chainTip", e, None))
    }

    /// Query committed contract events through the live RPC indexer.
    pub async fn events(&self, query: EventQuery) -> Result<EventPage, SubmissionError> {
        self.client()?
            .get_events(query)
            .await
            .map_err(|e| rpc_error("getEvents", e, None))
    }

    /// Read one committed block when the selected backend implements historical lookup.
    pub async fn block(
        &self,
        height: groundhog_json_rpc_types::BlockHeight,
    ) -> Result<Option<BlockInfo>, SubmissionError> {
        self.client()?
            .get_block_by_number(height)
            .await
            .map_err(|e| rpc_error("getBlockByNumber", e, None))
    }

    /// Sign and submit a call to `method` with the given calldata, wait for the
    /// receipt, and assert the transaction executed successfully.
    pub async fn invoke(&self, method: &str, calldata: Vec<u8>) -> TransactionReceipt {
        match self
            .submit(method, calldata, InvocationOptions::default())
            .await
            .unwrap_or_else(|e| panic!("submitting `{method}`: {e}"))
        {
            SubmissionOutcome::Committed(receipt) => {
                assert!(
                    matches!(receipt.status, ExecStatus::Ok),
                    "{}",
                    self.failure_diagnostics(method, &receipt)
                );
                receipt
            }
            SubmissionOutcome::Failed(receipt) => {
                panic!("{}", self.failure_diagnostics(method, &receipt))
            }
            SubmissionOutcome::Pending { .. } => {
                panic!("`{method}` receipt did not arrive within 30s")
            }
            SubmissionOutcome::Expired { .. } => panic!("`{method}` expired before committing"),
            SubmissionOutcome::Invalid { reason, .. } => {
                panic!("`{method}` was rejected by the scheduler: {reason}")
            }
        }
    }

    /// Sign and submit a call without panicking, using per-invocation settings.
    ///
    /// Receipts are authoritative. `RecentFailure` is advisory and remains a
    /// pending result while the transaction is unexpired.
    pub async fn submit(
        &self,
        method: &str,
        calldata: Vec<u8>,
        options: InvocationOptions,
    ) -> Result<SubmissionOutcome, SubmissionError> {
        let client = self.client()?;
        let tip = client
            .chain_tip()
            .await
            .map_err(|e| rpc_error("chainTip", e, None))?;
        let block_expiry_height = expiry_height(*tip.height, options.expiry);

        let tx = build_default_wallet_call_transaction(BuildDefaultWalletCallTransaction {
            account: &self.account,
            target_address: self.contract,
            target_entrypoint: self.entrypoint_id(method),
            target_calldata: &calldata,
            target_gas_limit: options.target_call_gas_limit,
            gas_limit: options.outer_transaction_gas_limit,
            block_expiry_height,
            nonce: self.nonce.fetch_add(1, Ordering::Relaxed),
        })
        .map_err(|e| SubmissionError::BuildTransaction(e.to_string()))?;

        let tx_hex = sign_and_encode_transaction_hex(
            tx,
            &self.signer,
            SignTransactionParams::default(),
            &self.network_hash,
        )
        .map_err(|e| SubmissionError::SignTransaction(e.to_string()))?;

        let tx_hash = client
            .send_raw_transaction(tx_hex)
            .await
            .map_err(|e| rpc_error("sendRawTransaction", e, None))?;
        eprintln!(
            "submitted `{method}`: tx={tx_hash:?}, expiry={block_expiry_height}, outer_gas={}, target_gas={}",
            options.outer_transaction_gas_limit, options.target_call_gas_limit
        );
        let deadline = Instant::now().checked_add(options.receipt_timeout);

        loop {
            if let Some(receipt) = client
                .get_transaction_receipt(tx_hash)
                .await
                .map_err(|e| rpc_error("getTransactionReceipt", e, Some(tx_hash)))?
            {
                return Ok(receipt_outcome(receipt));
            }

            let status = client
                .get_transaction_status(tx_hash)
                .await
                .map_err(|e| rpc_error("getTransactionStatus", e, Some(tx_hash)))?;
            if let TransactionStatus::Invalid { reason } = status {
                return Ok(SubmissionOutcome::Invalid { tx_hash, reason });
            }

            let tip = client
                .chain_tip()
                .await
                .map_err(|e| rpc_error("chainTip", e, Some(tx_hash)))?;
            let expired = *tip.height >= block_expiry_height;
            let timed_out = deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if expired
                && let Some(receipt) = client
                    .get_transaction_receipt(tx_hash)
                    .await
                    .map_err(|e| rpc_error("getTransactionReceipt", e, Some(tx_hash)))?
            {
                return Ok(receipt_outcome(receipt));
            }
            if let Some(outcome) = unresolved_outcome(status, tx_hash, expired, timed_out) {
                return Ok(outcome);
            }

            let sleep_for = deadline.map_or(options.receipt_poll_interval, |deadline| {
                options
                    .receipt_poll_interval
                    .min(deadline.saturating_duration_since(Instant::now()))
            });
            tokio::time::sleep(sleep_for).await;
        }
    }

    /// Derive the 8-byte entrypoint ID for one of the contract's methods.
    fn entrypoint_id(&self, method: &str) -> ContractEntrypointID {
        let sig = NormalizedMethodSignature::new(method);
        contract_entrypoint_id(Some(self.interface), self.version, &sig)
    }

    /// Render the call context a failed call needs for debugging, mirroring the
    /// diagnostics the `groundhog call` CLI prints: the native account and the
    /// default-wallet entrypoint it executes through, the target
    /// contract/method/entrypoint, and the receipt's status and abort payload.
    /// The receipt we already hold is our stand-in for the CLI's
    /// `groundhog_dev_getTransactionDetail` dump.
    fn failure_diagnostics(&self, method: &str, receipt: &TransactionReceipt) -> String {
        let abort_data = receipt
            .abort_data
            .as_ref()
            .map_or_else(|| "none".to_owned(), |data| format_hex_bytes(&data.0));
        format!(
            "`{method}` did not succeed\n  \
             status: {:?}\n  \
             account: {} entrypoint={}\n  \
             target: {} method=`{method}` entrypoint={}\n  \
             abort_data: {abort_data}",
            receipt.status,
            format_contract_address(&self.wallet),
            format_entrypoint_id(DEFAULT_WALLET_EXECUTE_ENTRYPOINT),
            format_contract_address(&self.contract),
            format_entrypoint_id(self.entrypoint_id(method)),
        )
    }
}

fn expiry_height(tip_height: i64, expiry: TransactionExpiry) -> i64 {
    match expiry {
        TransactionExpiry::Offset(offset) => tip_height.saturating_add(offset),
        TransactionExpiry::Absolute(height) => height,
    }
}

fn receipt_outcome(receipt: TransactionReceipt) -> SubmissionOutcome {
    match receipt.status {
        ExecStatus::Ok => SubmissionOutcome::Committed(receipt),
        _ => SubmissionOutcome::Failed(receipt),
    }
}

fn unresolved_outcome(
    status: TransactionStatus,
    tx_hash: TxHash,
    expired: bool,
    timed_out: bool,
) -> Option<SubmissionOutcome> {
    match status {
        TransactionStatus::Invalid { reason } => {
            Some(SubmissionOutcome::Invalid { tx_hash, reason })
        }
        TransactionStatus::Committed { .. } if timed_out => {
            Some(SubmissionOutcome::Pending { tx_hash })
        }
        TransactionStatus::Committed { .. } => None,
        _ if expired => Some(SubmissionOutcome::Expired { tx_hash }),
        _ if timed_out => Some(SubmissionOutcome::Pending { tx_hash }),
        _ => None,
    }
}

fn rpc_error(
    operation: &'static str,
    error: jsonrpsee_core::client::Error,
    tx_hash: Option<TxHash>,
) -> SubmissionError {
    let code = match &error {
        jsonrpsee_core::client::Error::Call(error) => Some(error.code()),
        _ => None,
    };
    SubmissionError::Rpc {
        operation,
        code,
        message: error.to_string(),
        tx_hash,
    }
}

/// Encode a method's arguments into calldata (the contract serialization the
/// node expects: each argument's XDR encoding, concatenated).
pub fn encode<T: xdrs::WriteXDR>(args: &T) -> Vec<u8> {
    xdrs::cxs::encode(args).expect("encode calldata")
}

/// Decode a transaction receipt's return value as `T`.
///
/// The transaction's root is the native account's default wallet, which
/// executes the target call and returns the list of its calls' return values
/// (one here). That envelope is stripped before decoding the method's own
/// return.
pub fn decode_return<T>(receipt: &TransactionReceipt) -> T
where
    T: for<'a> xdrs::ReadXDR<'a>,
{
    let data = receipt
        .return_data
        .as_ref()
        .expect("expected a return value");
    let returned = decode_default_wallet_call_return(data.0.as_slice())
        .expect("unwrap the default wallet's return");
    xdrs::cxs::decode(returned.as_slice()).expect("decode return value")
}

/// Decode a successful view response's return value as `T`.
pub fn decode_view_return<T>(response: &ViewResponse) -> T
where
    T: for<'a> xdrs::ReadXDR<'a>,
{
    let RootInvocationOutput::Return { return_data } = &response.output else {
        panic!(
            "expected a successful view return, got {:?}",
            response.output
        );
    };
    xdrs::cxs::decode(return_data.0.as_slice()).expect("decode view return value")
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

/// Resolve the native account address for `dev-{index}` from the runtime manifest.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tx_hash() -> TxHash {
        serde_json::from_str(&format!(r#""0x{}""#, "00".repeat(32)))
            .expect("test transaction hash should deserialize")
    }

    fn receipt(status: serde_json::Value) -> TransactionReceipt {
        serde_json::from_value(serde_json::json!({
            "txHash": format!("0x{}", "00".repeat(32)),
            "height": 10,
            "status": status,
            "events": [],
            "gasUsed": 0
        }))
        .expect("test receipt should deserialize")
    }

    #[test]
    fn invocation_options_preserve_invoke_defaults() {
        let options = InvocationOptions::default();

        assert_eq!(options.outer_transaction_gas_limit, DEFAULT_TX_GAS_LIMIT);
        assert_eq!(options.target_call_gas_limit, DEFAULT_TX_GAS_LIMIT);
        assert_eq!(
            options.expiry,
            TransactionExpiry::Offset(DEFAULT_EXPIRY_OFFSET)
        );
        assert_eq!(options.receipt_timeout, Duration::from_secs(30));
        assert_eq!(options.receipt_poll_interval, Duration::from_secs(1));
    }

    #[test]
    fn expiry_supports_offset_and_absolute_heights() {
        assert_eq!(expiry_height(42, TransactionExpiry::Offset(8)), 50);
        assert_eq!(expiry_height(42, TransactionExpiry::Absolute(91)), 91);
        assert_eq!(
            expiry_height(i64::MAX - 1, TransactionExpiry::Offset(8)),
            i64::MAX
        );
    }

    #[test]
    fn deterministic_receipts_are_exposed_separately() {
        let reverted = receipt(serde_json::json!({
            "result": "reverted",
            "message": "expected failure"
        }));
        let successful = receipt(serde_json::json!({ "result": "ok" }));

        assert!(matches!(
            receipt_outcome(reverted),
            SubmissionOutcome::Failed(_)
        ));
        assert!(matches!(
            receipt_outcome(successful),
            SubmissionOutcome::Committed(_)
        ));
    }

    #[test]
    fn recent_failure_remains_pending_while_unexpired() {
        let status: TransactionStatus = serde_json::from_value(serde_json::json!({
            "status": "recentFailure",
            "attemptHeight": 9,
            "cause": {
                "kind": "dbConflict",
                "conflict": {
                    "address": format!("0x{}", "00".repeat(32)),
                    "key": "0x",
                    "code": "exclusiveLock"
                }
            }
        }))
        .expect("test recent failure should deserialize");

        assert!(matches!(
            unresolved_outcome(status, tx_hash(), false, true),
            Some(SubmissionOutcome::Pending { .. })
        ));
    }

    #[test]
    fn unresolved_transaction_is_expired_only_at_expiry_height() {
        assert!(unresolved_outcome(TransactionStatus::Pending, tx_hash(), false, false).is_none());
        assert!(matches!(
            unresolved_outcome(TransactionStatus::Unknown, tx_hash(), true, false),
            Some(SubmissionOutcome::Expired { .. })
        ));
    }

    #[test]
    fn invalid_status_exposes_rejection_reason() {
        let outcome = unresolved_outcome(
            TransactionStatus::Invalid {
                reason: "bad nonce".to_owned(),
            },
            tx_hash(),
            false,
            false,
        );

        assert!(matches!(
            outcome,
            Some(SubmissionOutcome::Invalid { reason, .. }) if reason == "bad nonce"
        ));
    }
}
