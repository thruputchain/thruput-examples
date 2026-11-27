//! Driving the FHE contract on a node: an account that signs its own transactions (so that a
//! crank can carry up to the chain's 1e9 gas, where Testkit's agents use 1e7), and the calls a
//! user makes: create and upload a keyset, store ciphertexts, start gates and crank them.
//!
//! Every call goes through the account's `DefaultWallet.execute`, so the contract sees the
//! account's address as its caller. Uploads are submitted many at a time and then awaited, since
//! the contract counts them commutatively.

use crate::EvalKey;
use fhe_core::params::*;
use fhe_core::{Gate, Lwe};
use thruput_json_rpc_client::DecodedResponse;
use thruput_signing::default_wallet::{
    BuildDefaultWalletCallTransaction, build_default_wallet_call_transaction,
    decode_default_wallet_call_return,
};
use thruput_signing::{
    DEFAULT_PUBKEY_ACCOUNT_NONCE, LocalSigner, PubkeyAccount, SignTransactionParams,
    sign_and_encode_transaction_hex,
};
use thruput_testkit::rpc_types::requests::EmptyRequest;
use thruput_testkit::rpc_types::responses::{ReceiptExecution, TransactionReceipt};
use thruput_testkit::rpc_types::transaction::TxHash;
use thruput_testkit::xdr::types::{ContractAddress, NetworkHash};
use thruput_testkit::xdrs::{self, ReadXDR, WriteXDR};
use thruput_testkit::{AgentContext, Contract, Network, Result, TestkitError, entrypoint_id};

/// The contract's interface identity: its storage struct and crate version.
pub const INTERFACE: (&str, &str) = ("Fhe", "0.1.0");

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
#[xdr(crate = "thruput_testkit::xdrs")]
pub struct Job {
    pub keyset: u64,
    pub gate: u32,
    pub stage: u32,
    pub next: u32,
    pub output: u64,
}

pub const DONE: u32 = 2;

fn error(field: &'static str, detail: impl std::fmt::Display) -> TestkitError {
    TestkitError::Manifest {
        field,
        detail: detail.to_string(),
    }
}

/// A key-pair account with its own signer.
pub struct Account {
    pub network: Network,
    signer: LocalSigner,
    account: PubkeyAccount,
    network_hash: NetworkHash,
    nonce: u64,
    /// The method each submitted transaction calls, for error messages.
    methods: std::collections::HashMap<TxHash, String>,
}

impl Account {
    pub async fn new(network: Network, secret_key: [u8; 32]) -> Result<Self> {
        let signer = LocalSigner::from_secret_key(secret_key);
        let client = network.client().ok_or(TestkitError::Offline {
            operation: "getNetworkInfo",
        })?;
        let info = client
            .get_network_info(EmptyRequest {})
            .await
            .map_err(|e| error("networkHash", e))?;
        let DecodedResponse::Known(info) = info else {
            return Err(error("networkHash", "unsupported network identity"));
        };
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
            network,
            signer,
            account,
            network_hash: NetworkHash::from(info.network_hash.0),
            nonce,
            methods: Default::default(),
        })
    }

    pub fn address(&self) -> ContractAddress {
        self.account.address()
    }

    /// Sign and submit one call of `method` on `target`, without waiting.
    pub async fn submit<A: WriteXDR + ?Sized>(
        &mut self,
        target: ContractAddress,
        method: &str,
        args: &A,
        gas: u64,
    ) -> Result<TxHash> {
        let calldata = xdrs::cxs::encode(args).map_err(|e| error("calldata", e))?;
        self.nonce += 1;
        let tx = build_default_wallet_call_transaction(BuildDefaultWalletCallTransaction {
            account: &self.account,
            target_address: target,
            target_entrypoint: entrypoint_id(INTERFACE.0, INTERFACE.1, method),
            target_calldata: &calldata,
            target_gas_limit: gas,
            gas_limit: gas + WALLET_GAS,
            block_expiry_height: i64::MAX >> 1,
            nonce: self.nonce,
        })
        .map_err(|e| error("transaction", e))?;
        let tx_hex = sign_and_encode_transaction_hex(
            tx,
            &self.signer,
            SignTransactionParams::default(),
            &self.network_hash,
        )
        .map_err(|e| error("signing", e))?;
        let tx = self.network.submit_raw(tx_hex).await?;
        self.methods.insert(tx, method.to_owned());
        Ok(tx)
    }

    /// Await a receipt and require that the call returned.
    pub async fn wait(&self, tx: TxHash) -> Result<TransactionReceipt> {
        let receipt = self.network.await_receipt(tx).await?;
        match &receipt.execution {
            ReceiptExecution::Return { .. } => Ok(receipt),
            other => {
                let method = self.methods.get(&tx).map_or("?", |m| m.as_str());
                Err(error("execution", format!("{method} in {tx:?}: {other:?}")))
            }
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
    pub async fn create_keyset(&mut self) -> Result<u64> {
        let (id, _) = self
            .account
            .call(self.address, "create_keyset", &(), CALL_GAS)
            .await?;
        Ok(id)
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
    pub async fn get_ciphertext(&self, ctx: &AgentContext, id: u64) -> Result<Lwe> {
        let contract = Contract::new(self.address, INTERFACE.0, INTERFACE.1);
        let bytes: Vec<u8> = contract.view(ctx, "get_ciphertext", &id, None).await?;
        Lwe::from_bytes(&bytes[8..]).ok_or_else(|| error("ciphertext", "malformed"))
    }

    /// A full adder on ciphertexts `a`, `b` and carry-in `c`: five bootstrapped gates, three
    /// deep. Returns the ids of the sum and carry-out, and each gate's report.
    pub async fn full_adder(
        &mut self,
        ctx: &AgentContext,
        a: u64,
        b: u64,
        c: u64,
    ) -> Result<(u64, u64, Vec<(Gate, GateReport)>)> {
        let mut reports = Vec::new();
        let mut run = async |fhe: &mut Fhe, g: Gate, x: u64, y: u64| -> Result<u64> {
            let report = fhe.gate(ctx, g, x, y).await?;
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
    pub async fn gate(
        &mut self,
        ctx: &AgentContext,
        gate: Gate,
        x: u64,
        y: u64,
    ) -> Result<GateReport> {
        let mut transactions = Vec::new();
        let (job, receipt): (u64, _) = self
            .account
            .call(self.address, "start_gate", &(gate as u32, x, y), CALL_GAS)
            .await?;
        transactions.push((receipt.transaction_hash, receipt.gas_used));
        loop {
            let (state, receipt): (Job, _) = self
                .account
                .call(self.address, "crank", &job, CRANK_GAS)
                .await?;
            transactions.push((receipt.transaction_hash, receipt.gas_used));
            if state.stage == DONE {
                let output = self.get_ciphertext(ctx, state.output).await?;
                return Ok(GateReport {
                    output,
                    output_id: state.output,
                    transactions,
                });
            }
        }
    }
}
