//! Shared harness for RPC integration tests.
//!
//! These tests run against a *live* node, unlike the executor-backed tests.
//! They are driven by:
//!
//! ```bash
//! THRUPUT_DEVNODE_BINARY=/path/to/hog-devnode \
//!     thruput test --integration
//! ```
//!
//! `thruput test --integration` builds the contract to a guest binary, starts
//! an ephemeral hog-devnode, deploys the contract with a temporary integration key, and then runs
//! the test with the following environment set:
//!
//!   - `THRUPUT_RPC_URL`          — JSON-RPC endpoint of the ephemeral node
//!   - `THRUPUT_CONTRACT_ADDRESS` — address the contract was deployed to
//!   - `THRUPUT_DEFAULT_KEY`      — name of the temporary stored key
//!   - `THRUPUT_RUNTIME_MANIFEST` — path to the node's runtime manifest
//!
//! [`Harness`] holds everything needed to exercise a contract the way a client
//! would: it signs and submits transactions through the bootstrapped integration
//! native account, then hands back each transaction's receipt. The
//! contract-specific method calls and return decoding live in each contract's
//! own test.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use thruput_contract_util::{NormalizedMethodSignature, contract_entrypoint_id};
use thruput_json_rpc_client::{
    DecodedResponse, HttpClient, HttpClientBuilder, NativeClient, NativeClientError,
};
use thruput_json_rpc_types::base58::Base58;
use thruput_json_rpc_types::hex::HexBytes;
use thruput_json_rpc_types::requests::{
    BlockQuery, EmptyRequest, EventQuery, SendTransactionRequest, SimulateInvocationRequest,
    TransactionQuery,
};
use thruput_json_rpc_types::responses::{
    Admission, BlockInfo, ChainTip, EventPage, InvocationOutput as RootInvocationOutput,
    ReceiptExecution as ExecutionResult, SimulationResult as ViewResponse, TransactionReceipt,
    TransactionStatus,
};
use thruput_json_rpc_types::runtime_manifest::parse_runtime_manifest;
use thruput_json_rpc_types::transaction::{SchedulerTransactionError, TxHash};
use thruput_signing::default_wallet::{
    BuildDefaultWalletCallTransaction, DEFAULT_WALLET_EXECUTE_ENTRYPOINT,
    build_default_wallet_call_transaction, decode_default_wallet_call_return,
};
use thruput_signing::{
    DEFAULT_PUBKEY_ACCOUNT_NONCE, DEFAULT_TX_GAS_LIMIT, PubkeyAccount, SchemeSigner,
    SignTransactionParams, Signer, derive_default_dev_account_signer,
    sign_and_encode_transaction_hex,
};
use thruput_xdr::contract::ContractEntrypointID;
use thruput_xdr::types::{ContractAddress, NetworkHash, PublicKey};

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
    /// The scheduler permanently dropped the transaction.
    Dropped {
        tx_hash: TxHash,
        error: SchedulerTransactionError,
    },
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
    client: Result<NativeClient<HttpClient>, String>,
    contract: ContractAddress,
    /// Interface name and version of the deployed contract, used to derive
    /// entrypoint IDs for the methods under test.
    interface: &'static str,
    version: &'static str,
    signer: SchemeSigner,
    /// The integration key's native account: the transaction caller. Its address is the
    /// nonce-zero pubkey account of the signer, as the manifest confirms.
    account: PubkeyAccount,
    wallet: ContractAddress,
    network_hash: NetworkHash,
    /// Monotonic transaction nonce.
    nonce: AtomicU64,
}

impl Harness {
    /// Build a harness from the environment `thruput test --integration` sets,
    /// bound to the given contract `interface` name and `version` (used to
    /// derive the entrypoint ID of each method under test).
    pub fn from_env(interface: &'static str, version: &'static str) -> Self {
        let rpc_url = env("THRUPUT_RPC_URL");
        let client = HttpClientBuilder::default()
            .build(&rpc_url)
            .map(NativeClient::new)
            .map_err(|e| format!("{rpc_url}: {e}"));
        let contract = parse_address(&env("THRUPUT_CONTRACT_ADDRESS"));

        let manifest_path = env("THRUPUT_RUNTIME_MANIFEST");
        let manifest_json = std::fs::read(&manifest_path)
            .unwrap_or_else(|e| panic!("reading runtime manifest {manifest_path}: {e}"));
        let manifest = parse_runtime_manifest(&manifest_json)
            .unwrap_or_else(|e| panic!("parsing runtime manifest {manifest_path}: {e}"));

        let key_name = env("THRUPUT_DEFAULT_KEY");
        let signer = thruput_cli::keys::load_local_signer(&key_name)
            .unwrap_or_else(|e| panic!("loading integration key {key_name}: {e}"));
        let account = PubkeyAccount::new(signer.public_key(), DEFAULT_PUBKEY_ACCOUNT_NONCE);
        let wallet = account.address();
        let public_key = signer.public_key();
        let advertised = manifest
            .bootstrap_accounts
            .iter()
            .find(|entry| {
                public_key
                    == PublicKey::Ed25519 {
                        ed25519: entry.public_key.0,
                    }
            })
            .unwrap_or_else(|| {
                panic!("runtime manifest has no bootstrap allocation for the integration key")
            });
        assert_eq!(
            wallet, advertised.wallet_address.0,
            "runtime manifest bootstrap address differs from the integration key's native account"
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
            network_hash,
            nonce: AtomicU64::new(seed),
        }
    }

    /// Point this harness at a different contract.
    ///
    /// `from_env` binds to the contract `thruput test --integration` deployed,
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

    fn client(&self) -> Result<&NativeClient<HttpClient>, SubmissionError> {
        self.client
            .as_ref()
            .map_err(|message| SubmissionError::BuildClient(message.clone()))
    }

    /// The integration key's native account address — the caller of every transaction this
    /// harness submits.
    pub fn wallet(&self) -> ContractAddress {
        self.wallet
    }

    /// Address of the deployed contract this harness targets.
    pub fn contract(&self) -> ContractAddress {
        self.contract
    }

    /// Deterministic recipient address for a test. It has no bootstrap funding.
    pub fn recipient(&self, index: usize) -> ContractAddress {
        let signer = derive_default_dev_account_signer(index);
        PubkeyAccount::new(signer.public_key(), DEFAULT_PUBKEY_ACCOUNT_NONCE).address()
    }

    /// Execute a read-only contract call against the latest committed snapshot.
    pub async fn view(
        &self,
        method: &str,
        calldata: Vec<u8>,
    ) -> Result<ViewResponse, SubmissionError> {
        known(
            self.client()?
                .simulate_invocation(SimulateInvocationRequest {
                    address: Base58(self.contract),
                    entrypoint: HexBytes(self.entrypoint_id(method).into_inner().to_vec()),
                    calldata: HexBytes(calldata),
                    caller: Some(Base58(self.wallet)),
                    assumed_auth: None,
                    gas_limit: None,
                    min_state_block_height: None,
                })
                .await
                .map_err(|e| rpc_error("simulateInvocation", e, None))?,
            "simulateInvocation",
            None,
        )
    }

    /// Read the current committed block height and hash.
    pub async fn chain_tip(&self) -> Result<ChainTip, SubmissionError> {
        known(
            self.client()?
                .get_chain_tip(EmptyRequest {})
                .await
                .map_err(|e| rpc_error("getChainTip", e, None))?,
            "getChainTip",
            None,
        )
    }

    /// Query committed contract events through the live RPC indexer.
    pub async fn events(&self, query: EventQuery) -> Result<EventPage, SubmissionError> {
        known(
            self.client()?
                .get_events(query)
                .await
                .map_err(|e| rpc_error("getEvents", e, None))?,
            "getEvents",
            None,
        )
    }

    /// Read one committed block when the selected backend implements historical lookup.
    pub async fn block(
        &self,
        height: thruput_json_rpc_types::BlockHeight,
    ) -> Result<Option<BlockInfo>, SubmissionError> {
        known(
            self.client()?
                .get_block_by_height(BlockQuery {
                    block_height: height,
                })
                .await
                .map_err(|e| rpc_error("getBlockByHeight", e, None))?,
            "getBlockByHeight",
            None,
        )
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
                    matches!(receipt.execution, ExecutionResult::Return { .. }),
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
            SubmissionOutcome::Dropped { error, .. } => panic!("`{method}` was dropped: {error:?}"),
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
        let tip = self.chain_tip().await?;
        let block_expiry_height = expiry_height(*tip.block_height, options.expiry);

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

        let tx_hash = TxHash(Base58(
            thruput_signing::transaction_hash(&tx)
                .map_err(|e| SubmissionError::BuildTransaction(e.to_string()))?,
        ));
        let tx_hex = sign_and_encode_transaction_hex(
            tx,
            &self.signer,
            SignTransactionParams::default(),
            &self.network_hash,
        )
        .map_err(|e| SubmissionError::SignTransaction(e.to_string()))?;

        let signed_transaction = HexBytes(
            thruput_json_rpc_types::hex::decode_prefixed_hex(&tx_hex)
                .map_err(|e| SubmissionError::SignTransaction(e.to_string()))?,
        );
        let submitted = known(
            client
                .send_transaction(SendTransactionRequest { signed_transaction })
                .await
                .map_err(|e| rpc_error("sendTransaction", e, Some(tx_hash)))?,
            "sendTransaction",
            Some(tx_hash),
        )?;
        if submitted.transaction_hash != tx_hash
            || !matches!(submitted.admission, Admission::Accepted)
        {
            return Err(SubmissionError::Rpc {
                operation: "sendTransaction",
                code: None,
                message: "Unexpected admission evidence".into(),
                tx_hash: Some(tx_hash),
            });
        }
        eprintln!(
            "submitted `{method}`: tx={tx_hash:?}, expiry={block_expiry_height}, outer_gas={}, target_gas={}",
            options.outer_transaction_gas_limit, options.target_call_gas_limit
        );
        let deadline = Instant::now().checked_add(options.receipt_timeout);

        loop {
            if let Some(receipt) = known(
                client
                    .get_transaction_receipt(TransactionQuery {
                        transaction_hash: tx_hash,
                    })
                    .await
                    .map_err(|e| rpc_error("getTransactionReceipt", e, Some(tx_hash)))?,
                "getTransactionReceipt",
                Some(tx_hash),
            )? {
                return Ok(receipt_outcome(receipt));
            }

            let status = known(
                client
                    .get_transaction_status(TransactionQuery {
                        transaction_hash: tx_hash,
                    })
                    .await
                    .map_err(|e| rpc_error("getTransactionStatus", e, Some(tx_hash)))?,
                "getTransactionStatus",
                Some(tx_hash),
            )?;

            let tip = self.chain_tip().await?;
            let expired = *tip.block_height >= block_expiry_height;
            let timed_out = deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if (expired || matches!(status, TransactionStatus::Dropped { .. }))
                && let Some(receipt) = known(
                    client
                        .get_transaction_receipt(TransactionQuery {
                            transaction_hash: tx_hash,
                        })
                        .await
                        .map_err(|e| rpc_error("getTransactionReceipt", e, Some(tx_hash)))?,
                    "getTransactionReceipt",
                    Some(tx_hash),
                )?
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
    /// diagnostics the `thruput call` CLI prints: the native account and the
    /// default-wallet entrypoint it executes through, the target
    /// contract/method/entrypoint, and the receipt's status and abort payload.
    /// The receipt we already hold is our stand-in for the CLI's
    /// `groundhog_dev_getTransactionDetail` dump.
    fn failure_diagnostics(&self, method: &str, receipt: &TransactionReceipt) -> String {
        let abort_data = match &receipt.execution {
            ExecutionResult::Abort { abort_data } => format_hex_bytes(&abort_data.0),
            _ => "none".to_owned(),
        };
        format!(
            "`{method}` did not succeed\n  \
             status: {:?}\n  \
             account: {} entrypoint={}\n  \
             target: {} method=`{method}` entrypoint={}\n  \
             abort_data: {abort_data}",
            receipt.execution,
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
    match receipt.execution {
        ExecutionResult::Return { .. } => SubmissionOutcome::Committed(receipt),
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
        TransactionStatus::Committed { .. } if timed_out => {
            Some(SubmissionOutcome::Pending { tx_hash })
        }
        TransactionStatus::Committed { .. } => None,
        _ if expired => Some(SubmissionOutcome::Expired { tx_hash }),
        _ if timed_out => Some(SubmissionOutcome::Pending { tx_hash }),
        _ => None,
    }
}

fn known<T>(
    response: DecodedResponse<T>,
    operation: &'static str,
    tx_hash: Option<TxHash>,
) -> Result<T, SubmissionError> {
    match response {
        DecodedResponse::Known(value) => Ok(value),
        _ => Err(SubmissionError::Rpc {
            operation,
            code: None,
            message: "Unsupported RPC response".into(),
            tx_hash,
        }),
    }
}

fn rpc_error(
    operation: &'static str,
    error: NativeClientError,
    tx_hash: Option<TxHash>,
) -> SubmissionError {
    let code = match &error {
        NativeClientError::Application { source, .. } => Some(source.code()),
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
    let ExecutionResult::Return { return_data: data } = &receipt.execution else {
        panic!("expected a return value: {:?}", receipt.execution);
    };
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
    Base58(*address).to_string()
}

fn format_hex_bytes(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn parse_address(text: &str) -> ContractAddress {
    serde_json::from_value::<Base58<ContractAddress>>(serde_json::Value::String(text.to_owned()))
        .unwrap_or_else(|e| panic!("contract address `{text}` is not a base58 address: {e}"))
        .0
}

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| {
        panic!("{key} must be set (run this test via `thruput test --integration`)")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx_hash() -> TxHash {
        TxHash(Base58([0; 32].into()))
    }

    fn receipt(status: serde_json::Value) -> TransactionReceipt {
        serde_json::from_value(serde_json::json!({
            "transactionHash": tx_hash(),
            "blockHeight": "10",
            "execution": status,
            "events": [],
            "gasUsed": "0"
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
            "result": "abort",
            "abortData": "0x"
        }));
        let successful = receipt(serde_json::json!({ "result": "return", "returnData": "0x" }));

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
            "attemptBlockHeight": "9",
            "cause": {
                "kind": "dbConflict",
                "conflict": {
                    "address": Base58(ContractAddress::from([0; 32])),
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
        assert!(
            unresolved_outcome(
                TransactionStatus::Pending {
                    recent_failure: None
                },
                tx_hash(),
                false,
                false
            )
            .is_none()
        );
        assert!(matches!(
            unresolved_outcome(TransactionStatus::Unknown {}, tx_hash(), true, false),
            Some(SubmissionOutcome::Expired { .. })
        ));
    }

    #[test]
    fn dropped_and_retry_are_advisory() {
        let error = thruput_json_rpc_types::responses::SchedulerError {
            source: thruput_json_rpc_types::responses::SchedulerErrorSource::Scheduler,
            code: 7,
        };
        assert!(
            unresolved_outcome(
                TransactionStatus::Dropped {
                    error: error.clone(),
                    recent_failure: None
                },
                tx_hash(),
                false,
                false
            )
            .is_none()
        );
        assert!(
            unresolved_outcome(
                TransactionStatus::Retry {
                    error: error.clone(),
                    recent_failure: None
                },
                tx_hash(),
                false,
                false
            )
            .is_none()
        );
        assert!(matches!(
            unresolved_outcome(
                TransactionStatus::Retry {
                    error,
                    recent_failure: None
                },
                tx_hash(),
                false,
                true
            ),
            Some(SubmissionOutcome::Pending { .. })
        ));
    }
}
