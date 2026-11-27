//! Driving the FHE contract on a node over JSON-RPC: an account that signs its own transactions
//! (so that a crank can carry up to the chain's 1e9 gas), and the calls a user makes: create and
//! upload a keyset, store ciphertexts, start gates and crank them.
//!
//! Every call goes through the account's `DefaultWallet.execute`, so the contract sees the
//! account's address as its caller. Uploads are submitted many at a time and then awaited, since
//! the contract counts them commutatively. Nothing is ever resubmitted: an uncertain submission
//! is an error that names the transaction.

use crate::EvalKey;
use fhe_core::params::*;
use fhe_core::{Gate, Lwe};
use thruput_client::codec::method_entrypoint_id as entrypoint_id;
use thruput_json_rpc_client::native::NativeClient;
use thruput_json_rpc_client::native::receipt::{ReceiptPollConfig, poll_receipt};
use thruput_json_rpc_client::{DecodedResponse, HttpClient, HttpClientBuilder};
use thruput_json_rpc_types::NetworkHash;
use thruput_json_rpc_types::base58::Base58;
use thruput_json_rpc_types::hex::{HexBytes, decode_prefixed_hex};
use thruput_json_rpc_types::requests::{
    EmptyRequest, SendTransactionRequest, SimulateInvocationRequest,
};
use thruput_json_rpc_types::responses::{InvocationOutput, ReceiptExecution, TransactionReceipt};
use thruput_json_rpc_types::transaction::TxHash;
use thruput_signing::default_wallet::{
    BuildDefaultWalletCallTransaction, build_default_wallet_call_transaction,
    decode_default_wallet_call_return,
};
use thruput_signing::{
    DEFAULT_PUBKEY_ACCOUNT_NONCE, LocalSigner, PubkeyAccount, SignTransactionParams,
    sign_and_encode_transaction_hex, transaction_hash,
};
use thruput_xdr::types::{ContractAddress, NetworkHash as XdrNetworkHash};
use xdrs::{ReadXDR, WriteXDR};

/// The native token's address, `0x00…01`; it speaks the ERC20 interface.
pub fn native_token() -> ContractAddress {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    ContractAddress::from(bytes)
}

/// The contract's interface identity: its storage struct and crate version.
pub const INTERFACE: (&str, &str) = ("Fhe", "0.2.0");

/// The chain's per-transaction gas maximum (`maxTxGas`).
pub const MAX_TX_GAS: u64 = 1_000_000_000;
/// What the default wallet spends on top of the call it makes.
const WALLET_GAS: u64 = 2_000_000;
/// Gas for a crank: all a transaction may carry.
pub const CRANK_GAS: u64 = MAX_TX_GAS - WALLET_GAS;
/// Bootstrapping-key polynomials per upload transaction, and the gas that carries them.
pub const POLYS_PER_UPLOAD: usize = 6;
/// Key-switching sample groups per upload transaction.
pub const GROUPS_PER_UPLOAD: usize = 7;
pub const UPLOAD_GAS: u64 = 100_000_000;
/// Gas for the small calls.
pub const CALL_GAS: u64 = 20_000_000;

/// The contract's `Job`, as returned by `crank` and `get_job`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, xdrs::WriteXDR, xdrs::ReadXDR)]
pub struct Job {
    pub keyset: u64,
    pub gate: u32,
    pub stage: u32,
    pub next: u32,
    pub output: u64,
}

pub const DONE: u32 = 2;

/// What went wrong talking to the node.
#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

fn error(context: &str, detail: impl std::fmt::Debug) -> Error {
    Error(format!("{context}: {detail:?}"))
}

/// A key-pair account with its own signer, connected to one node.
pub struct Account {
    client: NativeClient<HttpClient>,
    signer: LocalSigner,
    account: PubkeyAccount,
    network_hash: NetworkHash,
    signing_hash: XdrNetworkHash,
    nonce: u64,
    /// The method each submitted transaction calls, for error messages.
    methods: std::collections::HashMap<TxHash, String>,
}

impl Account {
    /// Connect to `rpc_url`. With `expected_network`, refuse a node that serves another network
    /// before anything is signed.
    pub async fn connect(
        rpc_url: &str,
        expected_network: Option<&str>,
        secret_key: [u8; 32],
    ) -> Result<Self> {
        let transport = HttpClientBuilder::default()
            .build(rpc_url)
            .map_err(|e| error("connect", e))?;
        let client = NativeClient::new(transport);
        let info = client
            .get_network_info(EmptyRequest {})
            .await
            .map_err(|e| error("getNetworkInfo", e))?;
        let DecodedResponse::Known(info) = info else {
            return Err(Error("getNetworkInfo: unsupported response".into()));
        };
        let network_hash = info.network_hash;
        if let Some(expected) = expected_network
            && Base58(network_hash.0).to_string() != expected
        {
            return Err(Error(format!(
                "{rpc_url} serves network {}, not {expected}",
                Base58(network_hash.0)
            )));
        }
        let signer = LocalSigner::from_secret_key(secret_key);
        let account = PubkeyAccount::from_public_key_bytes(
            signer.verifying_key_bytes(),
            DEFAULT_PUBKEY_ACCOUNT_NONCE,
        );
        // Nonces only need to be unique; start from the clock so that reruns do not collide.
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64;
        Ok(Account {
            client,
            signer,
            account,
            network_hash,
            signing_hash: XdrNetworkHash::from(network_hash.0),
            nonce,
            methods: Default::default(),
        })
    }

    pub fn address(&self) -> ContractAddress {
        self.account.address()
    }

    /// Sign and submit one call of `method` on the FHE contract at `target`, without waiting.
    pub async fn submit<A: WriteXDR + ?Sized>(
        &mut self,
        target: ContractAddress,
        method: &str,
        args: &A,
        gas: u64,
    ) -> Result<TxHash> {
        self.submit_to(target, INTERFACE, method, args, gas).await
    }

    /// Sign and submit one call of `method` of `interface` (name, version) on `target`.
    pub async fn submit_to<A: WriteXDR + ?Sized>(
        &mut self,
        target: ContractAddress,
        interface: (&str, &str),
        method: &str,
        args: &A,
        gas: u64,
    ) -> Result<TxHash> {
        let calldata = xdrs::cxs::encode(args).map_err(|e| error("calldata", e))?;
        self.nonce += 1;
        let tx = build_default_wallet_call_transaction(BuildDefaultWalletCallTransaction {
            account: &self.account,
            target_address: target,
            target_entrypoint: entrypoint_id(interface.0, interface.1, method),
            target_calldata: &calldata,
            target_gas_limit: gas,
            gas_limit: gas + WALLET_GAS,
            block_expiry_height: i64::MAX >> 1,
            nonce: self.nonce,
        })
        .map_err(|e| error("transaction", e))?;
        let tx_hash = TxHash(Base58(transaction_hash(&tx).map_err(|e| error("hash", e))?));
        let tx_hex = sign_and_encode_transaction_hex(
            tx,
            &self.signer,
            SignTransactionParams::default(),
            &self.signing_hash,
        )
        .map_err(|e| error("signing", e))?;
        let bytes = decode_prefixed_hex(&tx_hex).map_err(|e| error("signing", e))?;
        let ack = self
            .client
            .send_transaction(SendTransactionRequest {
                signed_transaction: HexBytes(bytes),
            })
            .await
            .map_err(|e| error(&format!("{method}: sendTransaction for {tx_hash:?}"), e))?;
        match ack {
            DecodedResponse::Known(ack) if ack.transaction_hash == tx_hash => {}
            other => {
                return Err(error(
                    &format!("{method}: {tx_hash:?} acknowledged as"),
                    other,
                ));
            }
        }
        self.methods.insert(tx_hash, method.to_owned());
        Ok(tx_hash)
    }

    /// Await a receipt and require that the call returned.
    pub async fn wait(&self, tx: TxHash) -> Result<TransactionReceipt> {
        let method = self.methods.get(&tx).map_or("?", |m| m.as_str());
        let config = ReceiptPollConfig {
            timeout: std::time::Duration::from_secs(120),
            ..Default::default()
        };
        let receipt = poll_receipt(
            &self.client,
            self.network_hash,
            tx,
            None,
            config,
            std::future::pending(),
        )
        .await
        .map_err(|e| error(&format!("{method}: waiting for {tx:?}"), e))?;
        match &receipt.execution {
            ReceiptExecution::Return { .. } => Ok(receipt),
            other => Err(error(&format!("{method} in {tx:?}"), other)),
        }
    }

    /// Submit, wait, and decode the call's return value.
    pub async fn call<A: WriteXDR + ?Sized, R: for<'r> ReadXDR<'r>>(
        &mut self,
        target: ContractAddress,
        method: &str,
        args: &A,
        gas: u64,
    ) -> Result<(R, TransactionReceipt)> {
        let tx = self.submit(target, method, args, gas).await?;
        let receipt = self.wait(tx).await?;
        let ReceiptExecution::Return { return_data } = &receipt.execution else {
            unreachable!()
        };
        // The wallet returns one raw return buffer per call it ran.
        let returned =
            decode_default_wallet_call_return(&return_data.0).map_err(|e| error("return", e))?;
        let value = xdrs::cxs::decode(&returned).map_err(|e| error("return", e))?;
        Ok((value, receipt))
    }

    /// The network's storage deposit rates, from `getChainConfig`.
    pub async fn storage_rates(&self) -> Result<StorageRates> {
        let config = self
            .client
            .get_chain_config(EmptyRequest {})
            .await
            .map_err(|e| error("getChainConfig", e))?;
        let DecodedResponse::Known(config) = config else {
            return Err(Error("getChainConfig: unsupported response".into()));
        };
        let costs = &config
            .execution
            .as_ref()
            .ok_or_else(|| Error("getChainConfig: no storage costs".into()))?
            .storage_costs;
        Ok(StorageRates {
            item: costs.base_data_item_cost as u128,
            byte: costs.bytestring_cost_per_byte as u128,
        })
    }

    /// Simulate a read-only call (no transaction) and decode its return value.
    pub async fn view<A: WriteXDR + ?Sized, R: for<'r> ReadXDR<'r>>(
        &self,
        target: ContractAddress,
        method: &str,
        args: &A,
    ) -> Result<R> {
        let calldata = xdrs::cxs::encode(args).map_err(|e| error("calldata", e))?;
        let result = self
            .client
            .simulate_invocation(SimulateInvocationRequest {
                assumed_auth: None,
                min_state_block_height: None,
                address: Base58(target),
                entrypoint: HexBytes(
                    entrypoint_id(INTERFACE.0, INTERFACE.1, method)
                        .into_inner()
                        .to_vec(),
                ),
                calldata: HexBytes(calldata),
                caller: None,
                gas_limit: None,
            })
            .await
            .map_err(|e| error(method, e))?;
        let DecodedResponse::Known(result) = result else {
            return Err(Error(format!("{method}: unsupported response")));
        };
        match result.output {
            InvocationOutput::Return { return_data } => {
                xdrs::cxs::decode(&return_data.0).map_err(|e| error("return", e))
            }
            other => Err(error(method, other)),
        }
    }
}

/// A deployed FHE contract, used from one account.
pub struct Fhe {
    pub address: ContractAddress,
    pub account: Account,
}

/// What evaluating one gate took.
#[derive(Debug, Clone)]
pub struct GateReport {
    pub output: Lwe,
    pub output_id: u64,
    pub transactions: Vec<(TxHash, u64)>,
}

impl Fhe {
    /// Create a keyset paid with `funds` native-token base units from this account: first allow
    /// the contract to take them (`adjust_allowance` on the native token), then create. A whole
    /// key takes [`KEY_DEPOSIT`]; gates take [`JOB_DEPOSIT`] each.
    pub async fn create_keyset(&mut self, funds: u128) -> Result<u64> {
        self.check_rates().await?;
        let allowance = self
            .account
            .submit_to(
                native_token(),
                ("ERC20", "0.1.0"),
                "adjust_allowance",
                &(self.address, funds as i128),
                CALL_GAS,
            )
            .await?;
        self.account.wait(allowance).await?;
        let (id, _) = self
            .account
            .call(self.address, "create_keyset", &funds, CALL_GAS)
            .await?;
        Ok(id)
    }

    /// The deposit rates the contract charges keysets at, checked against the network's: were
    /// they lower, a keyset's recorded funds would exceed what the contract really holds.
    pub async fn check_rates(&self) -> Result<StorageRates> {
        let chain = self.account.storage_rates().await?;
        let rates: (u128, u128) = self.account.view(self.address, "get_rates", &()).await?;
        let contract = StorageRates {
            item: rates.0,
            byte: rates.1,
        };
        if contract != chain {
            return Err(Error(format!(
                "the contract charges {contract:?}, the network {chain:?}; refusing to fund a keyset"
            )));
        }
        Ok(chain)
    }

    /// Upload a whole evaluation key, `window` transactions in flight at a time; then seal it.
    /// `progress` is told how many transactions have been confirmed out of how many.
    pub async fn upload_keyset(
        &mut self,
        keyset: u64,
        key: &EvalKey,
        window: usize,
        mut progress: impl FnMut(usize, usize, &TransactionReceipt),
    ) -> Result<()> {
        let mut uploads: Vec<(&str, u32, Vec<u8>)> = Vec::new();
        for first in (0..BSK_POLYS).step_by(POLYS_PER_UPLOAD) {
            let end = (first + POLYS_PER_UPLOAD).min(BSK_POLYS);
            let data = (first..end).flat_map(|i| key.bsk_bytes(i)).collect();
            uploads.push(("upload_bsk", first as u32, data));
        }
        for first in (0..KS_GROUPS).step_by(GROUPS_PER_UPLOAD) {
            let end = (first + GROUPS_PER_UPLOAD).min(KS_GROUPS);
            let data = (first..end).flat_map(|g| key.ks_group_bytes(g)).collect();
            uploads.push(("upload_ksk", first as u32, data));
        }
        let total = uploads.len();
        let mut done = 0;
        for batch in uploads.chunks(window) {
            let mut pending = Vec::with_capacity(batch.len());
            for (method, first, data) in batch {
                let args = (keyset, *first, data.clone());
                pending.push(
                    self.account
                        .submit(self.address, method, &args, UPLOAD_GAS)
                        .await?,
                );
            }
            for tx in pending {
                let receipt = self.account.wait(tx).await?;
                done += 1;
                progress(done, total, &receipt);
            }
        }
        self.account
            .call::<_, ()>(self.address, "seal", &keyset, CALL_GAS)
            .await?;
        Ok(())
    }

    pub async fn put_ciphertext(&mut self, keyset: u64, ct: &Lwe) -> Result<u64> {
        let args = (keyset, ct.to_bytes().to_vec());
        let (id, _) = self
            .account
            .call(self.address, "put_ciphertext", &args, CALL_GAS)
            .await?;
        Ok(id)
    }

    pub async fn not(&mut self, x: u64) -> Result<u64> {
        let (id, _) = self.account.call(self.address, "not", &x, CALL_GAS).await?;
        Ok(id)
    }

    /// Read a ciphertext through a simulated view call (no transaction).
    pub async fn get_ciphertext(&self, id: u64) -> Result<Lwe> {
        let bytes: Vec<u8> = self
            .account
            .view(self.address, "get_ciphertext", &id)
            .await?;
        Lwe::from_bytes(&bytes[8..]).ok_or_else(|| error("ciphertext", "malformed"))
    }

    /// A full adder on ciphertexts `a`, `b` and carry-in `c`: five bootstrapped gates, three
    /// deep. Returns the ids of the sum and carry-out, and each gate's report.
    pub async fn full_adder(
        &mut self,
        a: u64,
        b: u64,
        c: u64,
    ) -> Result<(u64, u64, Vec<(Gate, GateReport)>)> {
        let mut reports = Vec::new();
        let mut run = async |fhe: &mut Fhe, g: Gate, x: u64, y: u64| -> Result<u64> {
            let report = fhe.gate(g, x, y).await?;
            let id = report.output_id;
            reports.push((g, report));
            Ok(id)
        };
        let ab = run(self, Gate::Xor, a, b).await?;
        let sum = run(self, Gate::Xor, ab, c).await?;
        let both = run(self, Gate::And, a, b).await?;
        let either = run(self, Gate::And, ab, c).await?;
        let carry = run(self, Gate::Or, both, either).await?;
        Ok((sum, carry, reports))
    }

    /// Evaluate `gate` on ciphertexts `x` and `y`: start the job and crank it to the end.
    pub async fn gate(&mut self, gate: Gate, x: u64, y: u64) -> Result<GateReport> {
        let mut transactions = Vec::new();
        let (job, receipt): (u64, _) = self
            .account
            .call(self.address, "start_gate", &(gate as u32, x, y), CALL_GAS)
            .await?;
        transactions.push((receipt.transaction_hash, receipt.gas_used));
        loop {
            let state = match self
                .account
                .call::<_, Job>(self.address, "crank", &job, CRANK_GAS)
                .await
            {
                Ok((state, receipt)) => {
                    transactions.push((receipt.transaction_hash, receipt.gas_used));
                    state
                }
                // Anyone may crank, so another account may have finished the job first; its
                // crank fails with `JobDone`. Read the job before giving up.
                Err(e) => {
                    let state: Job = self.account.view(self.address, "get_job", &job).await?;
                    if state.stage != DONE {
                        return Err(e);
                    }
                    state
                }
            };
            if state.stage == DONE {
                let output = self.get_ciphertext(state.output).await?;
                return Ok(GateReport {
                    output,
                    output_id: state.output,
                    transactions,
                });
            }
        }
    }
}
