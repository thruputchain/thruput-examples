//! What a clearing costs, measured on a live local `hog-devnode` through `groundhog-testkit`.
//!
//! The mock environment the other tests use does not meter gas the way a node does, so this drives
//! the real RV32 artifact: for every size in the sweep it deploys an exchange, submits a synthetic
//! batch ([`synthetic::batch`]) in one block, closes it, and then has the contract run its clearing
//! at each round cap through `measure_clearing`, which reports the gas of reading the cells, of
//! tâtonnement and of the circulation without recording anything. A real `clear_batch`, one
//! `submit_offer` and one `settle_offer` are measured from their receipts for the whole cost.
//!
//! It is `#[ignore]`d because it needs a devnode binary and built artifacts;
//! `scripts/speedex-bench.sh` wires both up. Roughly:
//!
//! ```text
//! groundhog build -p erc20 -- -F metadata
//! groundhog build -p speedex
//! GROUNDHOG_DEVNODE_BINARY="$(groundhog toolchain which)" \
//! GROUNDHOG_TESTKIT_ARTIFACT_ROOT=target/groundhog \
//!     cargo test -p speedex --test testkit_gas -- --ignored --nocapture
//! ```
//!
//! `SPEEDEX_GUEST_MEMORY` states the guest memory the artifact under test declares (the
//! protocol's 64 KiB unless set), which bounds the sweep's batch sizes; `scripts/speedex-bench.sh`
//! builds the artifact with more and starts the devnode admitting it.
//!
//! Every measurement is a CSV row in `SPEEDEX_GAS_OUT` (default: `speedex-gas.csv` in the
//! workspace's `target/`), which `scripts/speedex-plot.py` graphs together with the native
//! execution-quality runs. Blocks are produced by hand so that a batch's offers share one block
//! and every transaction is measured in a block of its own.

mod synthetic;

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use groundhog_signing::{
    BuildCallTransaction, DEFAULT_PUBKEY_ACCOUNT_NONCE, LocalSigner, PubkeyAccount,
    SignTransactionParams, build_call_transaction, derive_dev_account_signer,
    sign_and_encode_transaction_hex,
};
use groundhog_testkit::rpc_types::receipt::TransactionReceipt;
use groundhog_testkit::rpc_types::runtime_manifest::{RuntimeManifest, parse_runtime_manifest};
use groundhog_testkit::xdr::types::{ContractAddress, NetworkHash};
use groundhog_testkit::xdrs::{self, ReadXDR, WriteXDR};
use groundhog_testkit::{
    Agent, AgentContext, BlockDriverConfig, Contract, DeployOptions, LocalNetworkConfig,
    NetworkConfig, Result, Scenario, TestkitError, entrypoint_id,
};
use speedex::engine::{Grid, MAX_ASSETS};
use speedex::max_clear_cells_in;
use synthetic::{Rng, Shape};

/// Interface identities the artifacts stamp; `entrypoint_id` derives selectors from these.
const ERC20: (&str, &str) = ("ERC20", "0.1.44");
const SPEEDEX: (&str, &str) = ("Speedex", "0.1.0");
/// The node's default wallet, which serves every key-pair account: `execute` runs a list of
/// calls from the account, and takes calldata of any length.
const DEFAULT_WALLET: (&str, &str) = ("DefaultWallet", "0.1.0");

/// One call of the default wallet's `execute`.
#[derive(Debug, Clone, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "groundhog_testkit::xdrs")]
struct WalletCall {
    target: ContractAddress,
    entrypoint: [u8; 8],
    gas_limit: u64,
    calldata: Vec<u8>,
}

/// The grid every exchange is configured with (as `tests/quality.rs` and `tests/batch.rs`).
const GRID: Grid = Grid {
    octaves: 2,
    level_bits: 12,
};
/// The round cap the exchanges are configured with, which the real `clear_batch` runs at.
const ROUNDS: u32 = 64;

/// The sweep: assets, offers per batch, and the round caps `measure_clearing` is run at.
const ASSETS: [usize; 4] = [3, 4, 6, 8];
const OFFERS: [usize; 6] = [8, 32, 128, 512, 2048, 4096];
const ROUND_CAPS: [u32; 9] = [1, 2, 4, 8, 16, 32, 64, 128, 256];

/// Gas a clearing transaction is sent with. The testkit sends every transaction with 10M
/// through the dev wallet, which also takes at most 4 KiB of calldata; a clearing of thousands
/// of cells exceeds both, so the clearings are signed here as direct calls from the agent's
/// key-pair account, funded for the purpose, with this limit.
const CLEARING_GAS: u64 = 1_000_000_000;
/// Native tokens moved to the key-pair account to pay for the clearings.
const CLEARING_FUNDING: u128 = 500_000_000_000;
/// Offers submitted per block: the node bounds what one account may have in flight in a block.
const OFFERS_PER_BLOCK: usize = 1024;
/// Blocks per batch, enough for the largest sweep to be submitted in.
const EPOCH_LEN: u64 = 64;
// The node keeps at most 8,000 nonces per account and expiry height, and the testkit sends
// everything with one expiry height, so each asset count of the sweep runs on a devnode of its
// own, and the sweep's sizes (6,824 offers in all) stay under that.

/// Native (HOG) tokens granted to each contract for the storage it creates. The exchange writes
/// three records per offer, so it gets a great deal more than a token does.
const TOKEN_FUNDING: u128 = 1_000_000_000;
const EXCHANGE_FUNDING: u128 = 20_000_000_000;
/// What the bench account holds of each token, and allows each exchange.
const SUPPLY: u128 = 1 << 80;

/// `Clearing`, as the contract returns it.
#[derive(Debug, Clone, Copy, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "groundhog_testkit::xdrs")]
struct Clearing {
    prices: [u64; MAX_ASSETS],
    rounds: u32,
    pivots: u32,
    volume: u128,
    shortfall: u128,
}

/// `GasReport`, as `measure_clearing` returns it.
#[derive(Debug, Clone, Copy, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "groundhog_testkit::xdrs")]
struct GasReport {
    cells: u32,
    read: u64,
    prices: u64,
    circulation: u64,
    clearing: Clearing,
}

/// `Offer`, as the `offer` view returns it.
#[derive(Debug, Clone, Copy, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "groundhog_testkit::xdrs")]
struct Offer {
    owner: ContractAddress,
    batch: u64,
    sell: u32,
    buy: u32,
    level: u32,
    amount: u128,
}

/// One measurement.
struct Row {
    /// `measure`, `clear`, `submit` or `settle`.
    kind: &'static str,
    n: usize,
    offers: usize,
    cells: u32,
    round_cap: u32,
    rounds: u32,
    /// `ok`, or the receipt's failure (`fault` is what running out of gas reports).
    status: String,
    /// The whole transaction, from its receipt.
    gas_total: u64,
    /// The parts `measure_clearing` reports.
    gas_read: u64,
    gas_prices: u64,
    gas_circulation: u64,
    volume: u128,
    shortfall: u128,
}

const HEADER: &str = "kind,n,offers,cells,round_cap,rounds,status,gas_total,gas_read,gas_prices,\
gas_circulation,volume,shortfall";

impl Row {
    fn csv(&self) -> String {
        format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{}",
            self.kind,
            self.n,
            self.offers,
            self.cells,
            self.round_cap,
            self.rounds,
            self.status,
            self.gas_total,
            self.gas_read,
            self.gas_prices,
            self.gas_circulation,
            self.volume,
            self.shortfall,
        )
    }
}

/// The devnode's native token contract, at the genesis precompile address `0x00…01`, which speaks
/// the ERC20 interface (vendored at `groundhog-erc20-if` 0.1.3).
fn native_token() -> Contract {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    Contract::new(ContractAddress::from(bytes), "ERC20", "0.1.3")
}

fn status_of(receipt: &TransactionReceipt) -> String {
    use groundhog_testkit::rpc_types::receipt::ExecStatus;
    match &receipt.status {
        ExecStatus::Ok => "ok".to_owned(),
        ExecStatus::Reverted { message } => {
            format!("reverted({})", message.as_deref().unwrap_or("")).replace(',', ";")
        }
        ExecStatus::DeterministicError { kind } => kind.clone(),
        other => format!("{other:?}"),
    }
}

/// The bench agent's key-pair account, for the clearing transactions: the testkit's signer (from
/// the node's runtime manifest) signing direct calls, outside the dev wallet the testkit routes
/// everything through, with a nonce sequence of its own.
struct Account {
    account: PubkeyAccount,
    signer: LocalSigner,
    network_hash: NetworkHash,
    sequence: u32,
}

impl Account {
    fn of(ctx: &AgentContext) -> Result<Self> {
        let manifest = runtime_manifest()?;
        let signer = derive_dev_account_signer(
            &manifest.bootstrap_account_derivation.seed,
            ctx.account_index() as usize,
        );
        let account = PubkeyAccount::from_public_key_bytes(
            signer.verifying_key_bytes(),
            DEFAULT_PUBKEY_ACCOUNT_NONCE,
        );
        Ok(Account {
            account,
            signer,
            network_hash: manifest.network_hash.to_network_hash(),
            sequence: 0,
        })
    }

    fn address(&self) -> ContractAddress {
        self.account.address()
    }

    /// Submit `method` on `exchange` with [`CLEARING_GAS`], produce the block it runs in, and
    /// return its receipt whatever the outcome: a clearing that runs out of gas is a
    /// measurement too.
    async fn transact<A: WriteXDR + ?Sized>(
        &mut self,
        ctx: &mut AgentContext,
        exchange: &Contract,
        method: &str,
        args: &A,
    ) -> Result<TransactionReceipt> {
        let call = WalletCall {
            target: exchange.address(),
            entrypoint: entrypoint_id(SPEEDEX.0, SPEEDEX.1, method).into_inner(),
            gas_limit: CLEARING_GAS,
            calldata: xdrs::cxs::encode(args).expect("encoding calldata"),
        };
        let calldata = xdrs::cxs::encode(&vec![call]).expect("encoding the wallet call");
        self.sequence += 1;
        let tx = build_call_transaction(BuildCallTransaction {
            invoked_address: self.account.address(),
            entrypoint: entrypoint_id(DEFAULT_WALLET.0, DEFAULT_WALLET.1, "execute"),
            calldata,
            gas_limit: CLEARING_GAS,
            block_expiry_height: 10_000_000,
            nonce: (0x5bed_u64 << 40) | u64::from(self.sequence),
            auth_claim: self.account.auth_claim(),
        });
        let tx_hex = sign_and_encode_transaction_hex(
            tx,
            &self.signer,
            SignTransactionParams::default(),
            &self.network_hash,
        )
        .map_err(signing_error)?;
        let network = ctx.network().clone();
        let tx_hash = network.submit_raw(tx_hex).await?;
        network.await_pending(tx_hash).await?;
        network.produce_block().await?;
        network.await_receipt(tx_hash).await
    }
}

fn signing_error(e: impl std::fmt::Display) -> TestkitError {
    TestkitError::Manifest {
        field: "signing",
        detail: e.to_string(),
    }
}

/// The runtime manifest the devnode wrote for this run: the newest `runtime-manifest.json`
/// under the temporary directory.
fn runtime_manifest() -> Result<RuntimeManifest> {
    fn walk(dir: &std::path::Path, depth: usize, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && depth > 0 {
                walk(&path, depth - 1, found);
            } else if path
                .file_name()
                .is_some_and(|n| n == "runtime-manifest.json")
            {
                found.push(path);
            }
        }
    }
    let mut found = Vec::new();
    walk(&std::env::temp_dir(), 5, &mut found);
    let newest = found
        .into_iter()
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .ok_or(TestkitError::Manifest {
            field: "runtime-manifest.json",
            detail: "no runtime manifest found under the temporary directory".to_owned(),
        })?;
    let bytes = std::fs::read(&newest).map_err(|e| TestkitError::Manifest {
        field: "runtime-manifest.json",
        detail: e.to_string(),
    })?;
    parse_runtime_manifest(&bytes).map_err(|e| TestkitError::Manifest {
        field: "runtime-manifest.json",
        detail: e.to_string(),
    })
}

/// Call a method that must succeed, in a block of its own.
async fn call<A: WriteXDR + ?Sized>(
    ctx: &mut AgentContext,
    contract: &Contract,
    method: &str,
    args: &A,
) -> Result<TransactionReceipt> {
    let submitted = contract.submit_call(ctx, method, args).await?;
    submitted.await_pending().await?;
    ctx.network().produce_block().await?;
    submitted.await_receipt().await
}

fn decode<R: for<'r> ReadXDR<'r>>(receipt: &TransactionReceipt) -> R {
    let bytes = receipt
        .return_data
        .as_ref()
        .map_or(&[][..], |d| d.0.as_slice());
    xdrs::cxs::decode(bytes).expect("decoding a return value")
}

/// A return value from a call the default wallet made on the account's behalf: the wallet
/// returns one raw return buffer per call it ran.
fn decode_wallet<R: for<'r> ReadXDR<'r>>(receipt: &TransactionReceipt) -> R {
    let returns: Vec<Vec<u8>> = decode(receipt);
    xdrs::cxs::decode(&returns[0]).expect("decoding the call's return value")
}

/// Deploy an artifact in a block of its own.
async fn deploy(ctx: &mut AgentContext, name: &str) -> Result<ContractAddress> {
    let submitted = ctx
        .submit_deploy_artifact(name, DeployOptions::funded(0))
        .await?;
    submitted.await_pending().await?;
    ctx.network().produce_block().await?;
    Ok(submitted.await_receipt().await?.address)
}

/// Grant `target` native tokens to pay for the storage it will create.
async fn fund(ctx: &mut AgentContext, target: ContractAddress, amount: u128) -> Result<()> {
    let native = native_token();
    call(ctx, &native, "transfer", &(target, amount)).await?;
    Ok(())
}

/// The bench, as one agent: deploy the tokens once, then an exchange per size in the sweep.
fn bench(n: usize, shared: Arc<Mutex<Vec<Row>>>) -> Agent {
    Agent::new("bench", move |mut ctx| async move {
        let me = ctx.address();
        let zero = ContractAddress::from([0u8; 32]);
        let mut wallet = Account::of(&ctx)?;
        fund(&mut ctx, wallet.address(), CLEARING_FUNDING).await?;
        // The guest memory the artifact under test declares, which bounds a batch.
        let memory: usize = std::env::var("SPEEDEX_GUEST_MEMORY")
            .map(|v| v.parse().expect("SPEEDEX_GUEST_MEMORY in bytes"))
            .unwrap_or(64 * 1024);

        // The native token pays for its own storage, so it needs funds to store balances and
        // allowances.
        fund(&mut ctx, native_token().address(), TOKEN_FUNDING).await?;

        let mut tokens: Vec<Contract> = Vec::new();
        for _ in 0..n {
            let address = deploy(&mut ctx, "erc20").await?;
            fund(&mut ctx, address, TOKEN_FUNDING).await?;
            let token = Contract::new(address, ERC20.0, ERC20.1);
            call(&mut ctx, &token, "initialize", &me).await?;
            call(&mut ctx, &token, "mint", &(me, SUPPLY)).await?;
            tokens.push(token);
        }

        let mut rows: Vec<Row> = Vec::new();
        {
            // The sweep, cut at the configuration's cell cap (an offer per cell, near enough).
            let cap = max_clear_cells_in(memory, n);
            let sizes: Vec<usize> = OFFERS
                .iter()
                .map(|&o| o.min(cap))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect();
            for offers in sizes {
                println!("-- {n} assets, {offers} offers");
                let address = deploy(&mut ctx, "speedex").await?;
                fund(&mut ctx, address, EXCHANGE_FUNDING).await?;
                let exchange = Contract::new(address, SPEEDEX.0, SPEEDEX.1);
                let mut assets = [zero; MAX_ASSETS];
                for (a, token) in assets.iter_mut().zip(&tokens).take(n) {
                    *a = token.address();
                }
                call(
                    &mut ctx,
                    &exchange,
                    "initialize",
                    &(
                        n as u32,
                        assets,
                        EPOCH_LEN,
                        GRID.octaves,
                        GRID.level_bits,
                        ROUNDS,
                    ),
                )
                .await?;
                for token in tokens.iter().take(n) {
                    call(
                        &mut ctx,
                        token,
                        "adjust_allowance",
                        &(address, i128::try_from(SUPPLY).unwrap()),
                    )
                    .await?;
                }

                // The batch: every offer submitted, a block per thousand of them, all within
                // one epoch.
                let mut rng = Rng::new(((n as u64) << 32) ^ offers as u64);
                let batch = synthetic::batch(&mut rng, n, offers, GRID, Shape::default());
                let mut first: Option<[u8; 32]> = None;
                let mut batch_id: Option<u64> = None;
                for chunk in batch.offers.chunks(OFFERS_PER_BLOCK) {
                    let mut submitted = Vec::with_capacity(chunk.len());
                    for o in chunk {
                        let args = (o.sell as u32, o.buy as u32, o.amount, o.min_price);
                        submitted.push(
                            exchange
                                .submit_call(&mut ctx, "submit_offer", &args)
                                .await?,
                        );
                    }
                    for s in &submitted {
                        s.await_pending().await?;
                    }
                    ctx.network().produce_block().await?;
                    for s in &submitted {
                        let receipt = s.await_receipt().await?;
                        if first.is_none() {
                            let id: [u8; 32] = decode_wallet(&receipt);
                            first = Some(id);
                            let offer: Option<Offer> =
                                exchange.view(&ctx, "offer", &id, None).await?;
                            batch_id = Some(offer.expect("the offer was accepted").batch);
                            rows.push(Row {
                                kind: "submit",
                                n,
                                offers,
                                cells: batch.buckets.len() as u32,
                                round_cap: 0,
                                rounds: 0,
                                status: status_of(&receipt),
                                gas_total: receipt.gas_used,
                                gas_read: 0,
                                gas_prices: 0,
                                gas_circulation: 0,
                                volume: 0,
                                shortfall: 0,
                            });
                        }
                    }
                }
                let first = first.expect("a batch has offers");
                let batch_id = batch_id.expect("a batch has offers");

                // Close the batch: blocks until the exchange is on the next one.
                loop {
                    ctx.network().produce_block().await?;
                    let current: u64 = exchange.view(&ctx, "current_batch", &(), None).await?;
                    if current > batch_id {
                        break;
                    }
                }

                let cells = synthetic::cell_list(&batch.buckets);
                for &cap in &ROUND_CAPS {
                    let receipt = wallet
                        .transact(
                            &mut ctx,
                            &exchange,
                            "measure_clearing",
                            &(batch_id, &cells, cap),
                        )
                        .await?;
                    let status = status_of(&receipt);
                    let report: Option<GasReport> =
                        (status == "ok").then(|| decode_wallet(&receipt));
                    let r = report.as_ref();
                    rows.push(Row {
                        kind: "measure",
                        n,
                        offers,
                        cells: r.map_or(batch.buckets.len() as u32, |r| r.cells),
                        round_cap: cap,
                        rounds: r.map_or(0, |r| r.clearing.rounds),
                        status,
                        gas_total: receipt.gas_used,
                        gas_read: r.map_or(0, |r| r.read),
                        gas_prices: r.map_or(0, |r| r.prices),
                        gas_circulation: r.map_or(0, |r| r.circulation),
                        volume: r.map_or(0, |r| r.clearing.volume),
                        shortfall: r.map_or(0, |r| r.clearing.shortfall),
                    });
                    if let Some(r) = r {
                        println!(
                            "   cap {cap:>3}: {:>3} rounds, gas read {:>9} prices {:>10} \
                             circulation {:>10} total {:>10}",
                            r.clearing.rounds, r.read, r.prices, r.circulation, receipt.gas_used
                        );
                    } else {
                        println!(
                            "   cap {cap:>3}: {} after {} gas",
                            rows.last().unwrap().status,
                            receipt.gas_used
                        );
                    }
                }

                let receipt = wallet
                    .transact(&mut ctx, &exchange, "clear_batch", &(batch_id, &cells))
                    .await?;
                let status = status_of(&receipt);
                let clearing: Option<Clearing> = (status == "ok").then(|| decode_wallet(&receipt));
                println!(
                    "   clear_batch at the configured {ROUNDS}: {status}, {} gas",
                    receipt.gas_used
                );
                rows.push(Row {
                    kind: "clear",
                    n,
                    offers,
                    cells: batch.buckets.len() as u32,
                    round_cap: ROUNDS,
                    rounds: clearing.map_or(0, |c| c.rounds),
                    status: status.clone(),
                    gas_total: receipt.gas_used,
                    gas_read: 0,
                    gas_prices: 0,
                    gas_circulation: 0,
                    volume: clearing.map_or(0, |c| c.volume),
                    shortfall: clearing.map_or(0, |c| c.shortfall),
                });

                if status == "ok" {
                    let receipt = wallet
                        .transact(&mut ctx, &exchange, "settle_offer", &first)
                        .await?;
                    rows.push(Row {
                        kind: "settle",
                        n,
                        offers,
                        cells: batch.buckets.len() as u32,
                        round_cap: ROUNDS,
                        rounds: 0,
                        status: status_of(&receipt),
                        gas_total: receipt.gas_used,
                        gas_read: 0,
                        gas_prices: 0,
                        gas_circulation: 0,
                        volume: 0,
                        shortfall: 0,
                    });
                }
            }
        }

        shared.lock().unwrap().extend(rows);
        Ok(())
    })
}

#[tokio::test]
#[ignore = "needs GROUNDHOG_DEVNODE_BINARY and built erc20 and speedex artifacts"]
async fn clearing_gas() {
    let Ok(root) = std::env::var("GROUNDHOG_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set GROUNDHOG_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);
    let out = std::env::var("SPEEDEX_GAS_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/speedex-gas.csv")
        });

    let mut config = LocalNetworkConfig::default();
    config.dev_account_tokens = 1_000_000_000_000;
    config.block_driver = BlockDriverConfig::manual();
    if let Ok(bin) = std::env::var("GROUNDHOG_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }

    let rows = Arc::new(Mutex::new(Vec::new()));
    for &n in &ASSETS {
        let scenario = Scenario::builder("speedex-gas")
            .network(NetworkConfig::local(config.clone()))
            .artifact("erc20", artifact("erc20.rv32a"))
            .artifact("speedex", artifact("speedex.rv32a"))
            .build()
            .await
            .expect("local node starts with the artifacts registered");
        scenario
            .run_agents([bench(n, rows.clone())])
            .await
            .expect("the bench runs to completion");
        scenario.stop().await.expect("clean teardown");
    }

    let rows = rows.lock().unwrap();
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).expect("creating the output directory");
    }
    let mut file = std::fs::File::create(&out).expect("creating the CSV");
    writeln!(file, "{HEADER}").unwrap();
    for r in rows.iter() {
        writeln!(file, "{}", r.csv()).unwrap();
    }
    println!("wrote {} measurements to {}", rows.len(), out.display());
}
