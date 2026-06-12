//! Multi-contract RPC integration test for the swap example contracts.
//!
//! Run via:
//!
//! ```bash
//! GROUNDHOG_HOG_DEVNODE_BINARY=/path/to/hog-devnode \
//!   groundhog test --integration --hogd-protocol hogp/<hash> \
//!     -p swap_itest --bin swap_itest \
//!     --contract erc20 --contract swap --contract swap_driver --contract swap_router
//! ```
//!
//! `groundhog test --integration --bin` builds and *installs the code* of each
//! `--contract` on an ephemeral hog-devnode, then runs this binary with:
//!
//!   - `GROUNDHOG_RPC_URL`          — JSON-RPC endpoint of the ephemeral node
//!   - `GROUNDHOG_DEFAULT_KEY`      — `dev-0`
//!   - `GROUNDHOG_RUNTIME_MANIFEST` — path to the node's runtime manifest
//!   - `GROUNDHOG_CONTRACTS`        — path to a JSON manifest listing, per
//!     contract, its installed `code_hash` and `spec` path.
//!
//! This binary then deploys its own instances *by hash* and wires them up the
//! way the executor-based `swap_router/tests/common/setup.rs` does, but over
//! RPC: two `erc20` tokens, a `swap` pair (which internally deploys its LP
//! token from the same `erc20` code), a `swap_driver`, and a `swap_router`.
//! It then exercises an `add_liquidity` and a swap, asserting on the results.
//! Any failure panics, which exits non-zero so the CLI reports failure.

use groundhog_contract_util::{NormalizedMethodSignature, contract_entrypoint_id};
use groundhog_json_rpc_client::{GroundhogApiClient, HttpClientBuilder};
use groundhog_json_rpc_types::receipt::{ExecStatus, TransactionReceipt};
use groundhog_json_rpc_types::runtime_manifest::RuntimeManifest;
use groundhog_signing::{
    BuildDeployTransaction, BuildDevWalletDoActionTransaction, DEFAULT_TX_GAS_LIMIT, LocalSigner,
    SignTransactionParams, WALLET_DEPLOY_ENTRYPOINT, build_deploy_transaction,
    build_dev_wallet_do_action_transaction, derive_default_dev_account_signer,
    derive_deploy_address, sign_and_encode_transaction_hex, source_address_auth_claim,
};
use groundhog_xdr::contract::ContractEntrypointID;
use groundhog_xdr::types::{ContractAddress, SHA256Hash};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use xdr_common::VecM;

/// The dev wallet's `do_action` entrypoint (from the dev-wallet WASM exports).
const WALLET_DO_ACTION_ENTRYPOINT: [u8; 8] = 0x1984_6D75_0FAD_81D6_u64.to_be_bytes();

const RECEIPT_POLL_ATTEMPTS: u32 = 30;
const RECEIPT_POLL_INTERVAL: Duration = Duration::from_secs(1);

// Amounts exercised by the test.
const MINT: u128 = 1_000_000;
const LIQUIDITY: u128 = 100_000;
const SWAP_IN: u128 = 1_000;

#[tokio::main]
async fn main() {
    let h = Harness::from_env();
    h.run().await;
    println!("swap multi-contract integration test passed");
}

/// One installed contract: its code hash plus the interface name/version used
/// to derive entrypoint IDs (read from its `spec.json`, so version drift is a
/// non-issue).
struct ContractInfo {
    code_hash: SHA256Hash,
    interface: String,
    version: String,
}

struct Harness {
    rpc_url: String,
    signer: LocalSigner,
    /// dev-0's wallet contract address (the caller/deployer for everything).
    wallet: ContractAddress,
    /// Installed contracts, keyed by package name (from GROUNDHOG_CONTRACTS).
    contracts: HashMap<String, ContractInfo>,
    /// Monotonic transaction nonce.
    nonce: AtomicU64,
}

impl Harness {
    fn from_env() -> Self {
        let rpc_url = env("GROUNDHOG_RPC_URL");

        let manifest_path = env("GROUNDHOG_RUNTIME_MANIFEST");
        let manifest: RuntimeManifest = serde_json::from_str(
            &std::fs::read_to_string(&manifest_path)
                .unwrap_or_else(|e| panic!("reading runtime manifest {manifest_path}: {e}")),
        )
        .expect("parsing runtime manifest");

        let signer = derive_default_dev_account_signer(0);
        let wallet = wallet_address(&manifest, 0);

        let contracts = load_contracts(&env("GROUNDHOG_CONTRACTS"));

        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| u64::try_from(d.as_nanos()).ok())
            .unwrap_or(1);

        Self {
            rpc_url,
            signer,
            wallet,
            contracts,
            nonce: AtomicU64::new(seed),
        }
    }

    async fn run(&self) {
        let wallet = self.wallet;

        // --- A/B tokens: deploy two erc20 instances and put them under the
        //     wallet's control, then mint a balance to the wallet. ---
        let token0 = self.deploy("erc20").await;
        self.invoke(&token0, "erc20", "initialize", enc(&wallet)).await;
        let token1 = self.deploy("erc20").await;
        self.invoke(&token1, "erc20", "initialize", enc(&wallet)).await;

        self.invoke(&token0, "erc20", "mint", enc(&(wallet, MINT))).await;
        self.invoke(&token1, "erc20", "mint", enc(&(wallet, MINT))).await;

        // --- Pair: deploy and initialize with the two tokens and the erc20
        //     code hash (which the pair uses to deploy its own LP token). ---
        let lp_code_hash = self.code_hash("erc20");
        let pair = self.deploy("swap").await;
        self.invoke(
            &pair,
            "swap",
            "initialize",
            enc(&(wallet, token0, token1, lp_code_hash)),
        )
        .await;
        let lp = decode::<ContractAddress>(
            &self.invoke(&pair, "swap", "liquidity_token", vec![]).await,
        );

        // --- Driver and router. ---
        let driver = self.deploy("swap_driver").await;
        self.invoke(&driver, "swap_driver", "initialize", enc(&pair)).await;

        let router = self.deploy("swap_router").await;
        self.invoke(
            &router,
            "swap_router",
            "initialize",
            enc(&(driver, pair, token0, token1)),
        )
        .await;

        // --- Add liquidity through the router + driver. ---
        // The pair pulls the tokens via transfer_from, so the wallet must allow
        // the pair to spend them.
        self.invoke(&token0, "erc20", "adjust_allowance", enc(&(pair, LIQUIDITY as i128)))
            .await;
        self.invoke(&token1, "erc20", "adjust_allowance", enc(&(pair, LIQUIDITY as i128)))
            .await;
        self.invoke(
            &router,
            "swap_router",
            "add_liquidity",
            enc(&(token0, token1, [LIQUIDITY, LIQUIDITY], [0u128, 0u128], wallet)),
        )
        .await;
        let (processed, failed) =
            decode::<(u32, u32)>(&self.invoke(&driver, "swap_driver", "process_requests", vec![]).await);
        assert_eq!(processed, 1, "expected one purchase request to be processed");
        assert_eq!(failed, 0, "the purchase request failed");

        // Liquidity is now established and the wallet holds LP tokens.
        let (reserve0, reserve1, _ts) =
            decode::<(u128, u128, u32)>(&self.invoke(&pair, "swap", "get_reserves", vec![]).await);
        assert!(
            reserve0 > 0 && reserve1 > 0,
            "reserves not established: {reserve0}/{reserve1}"
        );
        let lp_balance =
            decode::<u128>(&self.invoke(&lp, "erc20", "get_balance_of", enc(&wallet)).await);
        assert!(lp_balance > 0, "wallet received no LP tokens");

        // --- Swap an exact amount of token0 for token1 through the router. ---
        let token1_before =
            decode::<u128>(&self.invoke(&token1, "erc20", "get_balance_of", enc(&wallet)).await);

        self.invoke(&token0, "erc20", "adjust_allowance", enc(&(pair, SWAP_IN as i128)))
            .await;
        self.invoke(
            &router,
            "swap_router",
            "swap_exact_tokens_for_tokens",
            enc(&(SWAP_IN, 0u128, token0, token1, wallet)),
        )
        .await;
        let (swapped, swap_failed) =
            decode::<(u32, u32)>(&self.invoke(&driver, "swap_driver", "process_requests", vec![]).await);
        assert_eq!(swapped, 1, "expected one swap request to be processed");
        assert_eq!(swap_failed, 0, "the swap request failed");

        let token1_after =
            decode::<u128>(&self.invoke(&token1, "erc20", "get_balance_of", enc(&wallet)).await);
        assert!(
            token1_after > token1_before,
            "swap delivered no token1 ({token1_before} -> {token1_after})"
        );

        println!(
            "reserves {reserve0}/{reserve1}, LP {lp_balance}, swap +{} token1",
            token1_after - token1_before
        );
    }

    /// Deploy a fresh instance of an installed contract by its code hash.
    async fn deploy(&self, contract: &str) -> ContractAddress {
        let code_hash = self.code_hash(contract);

        let nonce = self.next_nonce();
        let deploy_nonce = SHA256Hash::from(<[u8; 32]>::from(Sha256::digest(nonce.to_le_bytes())));
        let predicted = derive_deploy_address(&self.wallet, &deploy_nonce, &code_hash)
            .expect("derive deploy address");

        // Calldata for the wallet's deploy entrypoint: (nonce, code_hash).
        // No `contracts_to_deploy` — the code is already installed, so the
        // instance is created by hash (as the pair does for its LP token).
        let calldata = xdrs::cxs::encode(&(&deploy_nonce, &code_hash)).expect("encode deploy calldata");

        let tx = build_deploy_transaction(BuildDeployTransaction {
            invoked_address: self.wallet,
            entrypoint: ContractEntrypointID::from(WALLET_DEPLOY_ENTRYPOINT),
            calldata,
            gas_limit: DEFAULT_TX_GAS_LIMIT,
            block_expiry_height: self.block_expiry_height().await,
            nonce,
            contracts_to_deploy: VecM(vec![]),
            auth_claim: source_address_auth_claim(),
        });
        let tx_hex = sign_and_encode_transaction_hex(tx, &self.signer, SignTransactionParams::default())
            .expect("sign deploy");

        let receipt = self.submit(tx_hex, &format!("deploy {contract}")).await;

        // The wallet deploy entrypoint returns the instance address (32 bytes);
        // fall back to the locally-derived address if absent.
        match receipt.return_data.as_ref() {
            Some(data) if data.0.len() == 32 => {
                ContractAddress::from(<[u8; 32]>::try_from(data.0.as_slice()).unwrap())
            }
            _ => predicted,
        }
    }

    /// Sign and submit a `do_action` call to `method` on `target` (a method of
    /// the `contract`'s interface), wait for the receipt, assert success.
    async fn invoke(
        &self,
        target: &ContractAddress,
        contract: &str,
        method: &str,
        calldata: Vec<u8>,
    ) -> TransactionReceipt {
        let tx = build_dev_wallet_do_action_transaction(BuildDevWalletDoActionTransaction {
            wallet_address: self.wallet,
            wallet_entrypoint: ContractEntrypointID::from(WALLET_DO_ACTION_ENTRYPOINT),
            target_address: *target,
            target_entrypoint: self.entrypoint_id(contract, method),
            target_calldata: &calldata,
            gas_limit: DEFAULT_TX_GAS_LIMIT,
            target_gas_limit: DEFAULT_TX_GAS_LIMIT,
            block_expiry_height: self.block_expiry_height().await,
            nonce: self.next_nonce(),
        })
        .expect("build do_action transaction");
        let tx_hex = sign_and_encode_transaction_hex(tx, &self.signer, SignTransactionParams::default())
            .expect("sign do_action");
        self.submit(tx_hex, &format!("{contract}.{method}")).await
    }

    async fn submit(&self, tx_hex: String, label: &str) -> TransactionReceipt {
        let client = self.client();
        let tx_hash = client
            .send_raw_transaction(tx_hex)
            .await
            .unwrap_or_else(|e| panic!("sendRawTransaction for `{label}`: {e}"));

        for _ in 0..RECEIPT_POLL_ATTEMPTS {
            match client.get_transaction_receipt(tx_hash).await {
                Ok(Some(receipt)) => {
                    assert!(
                        matches!(receipt.status, ExecStatus::Ok),
                        "`{label}` did not succeed: {:?}",
                        receipt.status
                    );
                    return receipt;
                }
                Ok(None) => tokio::time::sleep(RECEIPT_POLL_INTERVAL).await,
                Err(e) => panic!("getTransactionReceipt for `{label}`: {e}"),
            }
        }
        let status = client.get_transaction_status(tx_hash).await;
        panic!(
            "`{label}` receipt did not arrive within {RECEIPT_POLL_ATTEMPTS}s \
             (tx {tx_hash:?}, status {status:?})"
        );
    }

    async fn block_expiry_height(&self) -> i64 {
        let tip = self.client().chain_tip().await.expect("chainTip");
        i64::from(*tip.height).saturating_add(1_000)
    }

    fn entrypoint_id(&self, contract: &str, method: &str) -> ContractEntrypointID {
        let info = self
            .contracts
            .get(contract)
            .unwrap_or_else(|| panic!("unknown contract `{contract}`"));
        let sig = NormalizedMethodSignature::new(method);
        let id = contract_entrypoint_id(Some(&info.interface), &info.version, &sig);
        let bytes: [u8; 8] = id.as_ref()[..8]
            .try_into()
            .expect("entrypoint ID is at least 8 bytes");
        ContractEntrypointID::from(bytes)
    }

    fn code_hash(&self, contract: &str) -> SHA256Hash {
        self.contracts
            .get(contract)
            .unwrap_or_else(|| panic!("unknown contract `{contract}`"))
            .code_hash
    }

    fn next_nonce(&self) -> u64 {
        self.nonce.fetch_add(1, Ordering::Relaxed)
    }

    fn client(&self) -> impl GroundhogApiClient {
        HttpClientBuilder::default()
            .build(&self.rpc_url)
            .expect("build JSON-RPC client")
    }
}

/// Parse the `GROUNDHOG_CONTRACTS` manifest into per-contract info, reading each
/// contract's `spec.json` for its interface name and version.
fn load_contracts(manifest_path: &str) -> HashMap<String, ContractInfo> {
    let text = std::fs::read_to_string(manifest_path)
        .unwrap_or_else(|e| panic!("reading contracts manifest {manifest_path}: {e}"));
    let json: Value = serde_json::from_str(&text).expect("parsing contracts manifest");

    let entries = json["contracts"]
        .as_array()
        .expect("contracts manifest: `contracts` must be an array");

    let mut contracts = HashMap::new();
    for entry in entries {
        let name = entry["name"]
            .as_str()
            .expect("contract entry missing `name`")
            .to_string();
        let code_hash = parse_hash(&entry["code_hash"]);
        let spec = entry["spec"]
            .as_str()
            .unwrap_or_else(|| panic!("contract `{name}` has no spec path in the manifest"));
        let (interface, version) = read_interface(spec);
        contracts.insert(
            name,
            ContractInfo {
                code_hash,
                interface,
                version,
            },
        );
    }
    contracts
}

/// Read the (single) interface name and version from a contract `spec.json`.
fn read_interface(spec_path: &str) -> (String, String) {
    let text = std::fs::read_to_string(spec_path)
        .unwrap_or_else(|e| panic!("reading contract spec {spec_path}: {e}"));
    let json: Value = serde_json::from_str(&text).expect("parsing contract spec");
    let interface = &json["interfaces"][0];
    let name = interface["name"]
        .as_str()
        .unwrap_or_else(|| panic!("spec {spec_path} has no interface name"))
        .to_string();
    let version = interface["version"]
        .as_str()
        .unwrap_or_else(|| panic!("spec {spec_path} has no interface version"))
        .to_string();
    (name, version)
}

/// Parse a code hash from the manifest, accepting either a hex string or a
/// byte array (whichever the serializer produced).
fn parse_hash(value: &Value) -> SHA256Hash {
    let bytes: Vec<u8> = match value {
        Value::String(s) => {
            let s = s.strip_prefix("0x").unwrap_or(s);
            hex::decode(s).unwrap_or_else(|e| panic!("code_hash `{s}` is not valid hex: {e}"))
        }
        Value::Array(items) => items
            .iter()
            .map(|x| u8::try_from(x.as_u64().expect("code_hash byte")).expect("code_hash byte"))
            .collect(),
        other => panic!("unexpected code_hash form: {other}"),
    };
    let bytes: [u8; 32] = bytes
        .try_into()
        .unwrap_or_else(|_| panic!("code_hash is not 32 bytes"));
    SHA256Hash::from(bytes)
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

/// Encode method arguments into calldata (each argument's XDR encoding,
/// concatenated — a tuple encodes as the concatenation of its fields).
fn enc<T: xdrs::WriteXDR>(args: &T) -> Vec<u8> {
    xdrs::cxs::encode(args).expect("encode calldata")
}

/// Decode a return value from a transaction receipt.
fn decode<T: xdrs::ReadXDROwned>(receipt: &TransactionReceipt) -> T {
    let data = receipt
        .return_data
        .as_ref()
        .expect("expected a return value");
    xdrs::cxs::decode::<T>(data.0.as_slice()).expect("decode return value")
}

fn env(key: &str) -> String {
    std::env::var(key)
        .unwrap_or_else(|_| panic!("{key} must be set (run via `groundhog test --integration`)"))
}
