//! Simulate traders swapping through the router, block by block, and report how
//! the request queue behaves.
//!
//! A swap is not performed when it is submitted: the router only enqueues a
//! request with the pool's driver, and the swap happens later, when someone
//! "cranks" the driver with `process_requests` in a transaction of its own (see
//! the `swap-if` crate docs). This test drives that whole cycle on a live local
//! `hog-devnode`, much as the Swap app does: each trader submits a swap request,
//! the queue is cranked, and the trader watches for the event that says its
//! request was served.
//!
//! The node runs in manual block mode, and a `chain` agent produces each block
//! only once every participant has submitted what it wants in that block. That
//! pins down which block each transaction was submitted for, so the test can
//! report, block by block and request by request:
//!
//! * how many blocks pass between submitting a swap request and its being served,
//! * how many swaps each block performs (and how many fail), and
//! * which cranks the node dropped for conflicting with another transaction in
//!   their block, and which found nothing to do.
//!
//! Each test runs the same traders under a different cranking policy (see
//! [`Cranking`]). The report is printed; run with `--no-capture` to see it.
//!
//! Like `sim_liquidity`, these are `#[ignore]`d because they need the `thruput`
//! CLI and built artifacts:
//!
//! ```shell
//! for c in erc20 swap-handler swap-driver swap-router swap-factory; do thruput build -p "$c"; done
//! THRUPUT_TESTKIT_ARTIFACT_ROOT=/path/to/target/thruput \
//!     cargo test -p swap-router --test sim_swap -- --ignored --no-capture --test-threads 1
//! ```

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use batch_driver::{RequestAccepted, RequestFailed};
use swap_if::SwapEvent;
use thruput_erc20_if::Amount;
use thruput_event::Event;
use thruput_json_rpc_types::responses::{ReceiptExecution, TransactionReceipt, TransactionStatus};
use thruput_json_rpc_types::transaction::TxHash;
use thruput_testkit::xdr::types::ContractAddress;
use thruput_testkit::{
    Agent, AgentContext, BlockDriverConfig, LocalNetworkConfig, NetworkConfig, Result, Scenario,
    xdrs,
};

// An alias to match the contracts' `Address` type.
pub type Address = ContractAddress;

mod sim;
use sim::*;

// The traders. Keep there fewer than the factory's `MIN_CRANK_BATCH` (8): a
// crank facing a queue that deep must declare more gas than the testkit gives a
// call, and is refused.
const TRADERS: [&str; 6] = ["t1", "t2", "t3", "t4", "t5", "t6"];

// The agent that does all the cranking under `Cranking::Keeper`.
const KEEPER: &str = "keeper";

// How many swaps each trader makes.
const TRADES: usize = 4;

// What the admin airdrops each trader per token, and what one swap moves.
const TRADER_FUNDS: Amount = 1_000_000;
const TRADE_SIZE: Amount = 1_000;

// A backstop: no run should need anywhere near this many blocks.
const MAX_BLOCKS: usize = 200;

/// Who cranks the queue, and when.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cranking {
    /// Each trader cranks once its request has committed, as the Swap app does.
    AfterRequest,
    /// Each trader cranks in the same block as its request.
    WithRequest,
    /// Traders never crank; a keeper cranks whenever requests are waiting.
    Keeper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Request,
    Crank,
}

/// What became of a transaction.
#[derive(Debug, Clone, Copy)]
enum Outcome {
    /// A request, enqueued with the id it was stamped with.
    Enqueued { height: i64, id: [u8; 32] },
    /// A crank, which drained `processed` requests.
    Cranked { height: i64, processed: u32 },
    /// Committed, but reverted. (For a crank, typically `BatchTooSmall`.)
    Reverted { height: i64 },
    /// Left out of block `height` for conflicting with another transaction in
    /// it, and dropped: it lands only if resubmitted.
    Dropped { height: i64 },
}

impl Outcome {
    fn height(&self) -> i64 {
        match *self {
            Outcome::Enqueued { height, .. }
            | Outcome::Cranked { height, .. }
            | Outcome::Reverted { height }
            | Outcome::Dropped { height } => height,
        }
    }
}

/// One submitted transaction, as the chain agent has observed it so far.
#[derive(Debug, Clone)]
struct Tx {
    hash: TxHash,
    kind: Kind,
    // The last block produced before this was submitted: the next one is the
    // first it could land in.
    submitted_after: i64,
    // How many blocks were produced without including it.
    held: u32,
    outcome: Option<Outcome>,
}

/// How a request was finally served: in which block, and whether it succeeded.
#[derive(Debug, Clone, Copy)]
struct Service {
    height: i64,
    ok: bool,
}

/// Everything submitted during the run, and what became of it.
///
/// Participants record what they submit; the chain agent records what each
/// block did with it. (The Swap app learns the same from receipts and from the
/// pool's events: see `apps/swap/src/transactions/request-observer.ts`.)
#[derive(Debug, Default)]
struct Ledger {
    // The last block produced.
    tip: i64,
    txs: Vec<Tx>,
    // Keyed by request id.
    served: HashMap<[u8; 32], Service>,
}

type SharedLedger = Arc<Mutex<Ledger>>;

fn lock(ledger: &SharedLedger) -> MutexGuard<'_, Ledger> {
    ledger.lock().expect("bug: a ledger user panicked")
}

impl Ledger {
    // Record a submission, returning its index.
    fn record(&mut self, kind: Kind, hash: TxHash) -> usize {
        self.txs.push(Tx {
            hash,
            kind,
            submitted_after: self.tip,
            held: 0,
            outcome: None,
        });
        self.txs.len() - 1
    }

    fn landed(&self, index: usize) -> bool {
        self.txs[index].outcome.is_some()
    }

    // The request's id, once it has been enqueued.
    fn request_id(&self, index: usize) -> Option<[u8; 32]> {
        match self.txs[index].outcome {
            Some(Outcome::Enqueued { id, .. }) => Some(id),
            Some(other) => panic!("swap request did not enqueue: {other:?}"),
            None => None,
        }
    }

    // Whether the request submitted as `index` has been served.
    fn is_served(&self, index: usize) -> bool {
        self.request_id(index)
            .is_some_and(|id| self.served.contains_key(&id))
    }

    fn requests(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.txs.len()).filter(|&i| self.txs[i].kind == Kind::Request)
    }

    // Whether an enqueued request is waiting to be served.
    fn any_waiting(&self) -> bool {
        self.requests()
            .any(|i| self.request_id(i).is_some() && !self.is_served(i))
    }

    // Whether every trade has been submitted and served.
    fn all_served(&self) -> bool {
        self.requests().count() == TRADERS.len() * TRADES
            && self.requests().all(|i| self.is_served(i))
    }
}

// The contract addresses a participant needs, sent to it over the mailbox.
#[derive(Debug, Clone, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "thruput_testkit::xdrs")]
struct Config {
    token0: Address,
    token1: Address,
    handler: Address,
    router: Address,
    driver: Address,
}

// The admin agent sets up and primes the pool, then funds the participants and
// sends them the addresses they need.
fn admin(participants: Vec<&'static str>) -> Agent {
    Agent::new("admin", move |mut ctx| async move {
        let native = native_token(&ctx);
        let s = deploy_and_init(&mut ctx, &native, None).await?;
        prime_pool(&ctx, &s).await?;

        let config = Config {
            token0: s.token0.address(),
            token1: s.token1.address(),
            handler: s.handler,
            router: s.router.address(),
            driver: s.driver.address(),
        };
        for _ in &participants {
            let hello = ctx
                .recv_from_any::<Address>(&participants)
                .await
                .expect("bug: a participant closed before greeting")?;
            s.token0.mint(&hello.body, TRADER_FUNDS).await?;
            s.token1.mint(&hello.body, TRADER_FUNDS).await?;
            ctx.send(&hello.from, &config)?;
        }

        // Once every participant is ready, setup is over.
        for _ in &participants {
            ctx.recv_from_any::<()>(&participants)
                .await
                .expect("bug: a participant closed during setup")?;
        }
        ctx.send("chain", &())?;
        Ok(())
    })
}

// Greet the admin, and receive the addresses of the suite.
async fn join(ctx: &mut AgentContext) -> Result<Config> {
    ctx.send("admin", &ctx.address())?;
    Ok(ctx
        .recv_from("admin")
        .await
        .expect("bug: admin closed before sending addresses")?
        .body)
}

// Wait for the chain agent to produce the next block (or, the first time, to
// finish setup).
async fn next_block(ctx: &mut AgentContext) -> Result<()> {
    ctx.recv_from::<i64>("chain")
        .await
        .expect("bug: chain closed while trading")?;
    Ok(())
}

// The chain agent produces the node's blocks.
//
// During setup it produces them continually, so the admin's and participants'
// transactions land as they would on a node producing its own. After that it
// produces each block only once every participant has reported that its
// submissions for it are pending, and records what the block did with them.
fn chain(participants: Vec<&'static str>, ledger: SharedLedger) -> Agent {
    Agent::new("chain", move |mut ctx| async move {
        let network = ctx.network().clone();

        while ctx.try_recv_from::<()>("admin").is_none() {
            network.produce_block().await?;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut height = network.chain_tip().await?.block_height.into_inner();
        lock(&ledger).tip = height;

        let mut active = participants;
        for _ in 0..MAX_BLOCKS {
            for &participant in &active {
                ctx.send(participant, &height)?;
            }

            // Each participant reports whether it is done.
            let mut busy = Vec::new();
            for &participant in &active {
                let done: bool = ctx
                    .recv_from(participant)
                    .await
                    .expect("bug: a participant closed while trading")?
                    .body;
                if !done {
                    busy.push(participant);
                }
            }
            active = busy;
            if active.is_empty() {
                return Ok(());
            }

            height = network.produce_block().await?.height;
            observe_block(&ctx, &ledger, height).await?;
        }
        panic!("participants were still busy after {MAX_BLOCKS} blocks");
    })
}

// Record what block `height` did with each transaction still outstanding.
async fn observe_block(ctx: &AgentContext, ledger: &SharedLedger, height: i64) -> Result<()> {
    let network = ctx.network();
    let outstanding: Vec<(usize, TxHash, Kind)> = lock(ledger)
        .txs
        .iter()
        .enumerate()
        .filter(|(_, tx)| tx.outcome.is_none())
        .map(|(i, tx)| (i, tx.hash, tx.kind))
        .collect();

    for (index, hash, kind) in outstanding {
        match network.transaction_status(hash).await? {
            TransactionStatus::Committed { .. } => {
                let receipt = network.await_receipt(hash).await?;
                let (outcome, served) = read_receipt(kind, &receipt);
                let mut ledger = lock(ledger);
                ledger.txs[index].outcome = Some(outcome);
                for (id, ok) in served {
                    let service = Service {
                        height: outcome.height(),
                        ok,
                    };
                    let earlier = ledger.served.insert(id, service);
                    assert!(earlier.is_none(), "a request was served twice");
                }
            }
            TransactionStatus::Pending { .. } => lock(ledger).txs[index].held += 1,
            // A transaction that conflicted with another in two-phase commit
            // (`ExecResultTxNonDeterministicError`) is left out of the block and
            // reported as one to retry: it is gone from the mempool, and lands only
            // if the same signed transaction is submitted again.
            TransactionStatus::Retry { error, .. } if error.code == 3 => {
                assert_eq!(kind, Kind::Crank, "a swap request was dropped: {hash:?}");
                lock(ledger).txs[index].outcome = Some(Outcome::Dropped { height });
            }
            other => panic!("{kind:?} {hash:?} was not accepted: {other:?}"),
        }
    }
    lock(ledger).tip = height;
    Ok(())
}

// Read a committed transaction's outcome from its receipt, along with the
// requests it served (by id, and whether each succeeded).
fn read_receipt(kind: Kind, receipt: &TransactionReceipt) -> (Outcome, Vec<([u8; 32], bool)>) {
    let height = receipt.block_height.clone().into_inner();
    if !matches!(receipt.execution, ReceiptExecution::Return { .. }) {
        return (Outcome::Reverted { height }, Vec::new());
    }

    let events_of = |signature: &'static [u8; 32]| {
        receipt
            .events
            .iter()
            .filter(move |e| e.topics.first().is_some_and(|t| &t.0 == signature))
    };
    let accepted = <RequestAccepted as Event>::signature().expect("RequestAccepted is signed");
    let swapped = <SwapEvent as Event>::signature().expect("SwapEvent is signed");
    let failed = <RequestFailed as Event>::signature().expect("RequestFailed is signed");

    match kind {
        Kind::Request => {
            // The request's id is `RequestAccepted`'s one topic after its signature.
            let event = events_of(accepted)
                .next()
                .expect("an enqueued request emits RequestAccepted");
            let id = event.topics[1].0;
            (Outcome::Enqueued { height, id }, Vec::new())
        }
        Kind::Crank => {
            // A served request emits a `SwapEvent` carrying its id, or the driver
            // emits a `RequestFailed` naming it.
            let mut served = Vec::new();
            for event in events_of(swapped) {
                let payload = <SwapEvent as Event>::decode_payload(&event.data.0)
                    .expect("decoding a SwapEvent");
                let id = payload
                    .request_id
                    .expect("a cranked swap carries its request id");
                served.push((id.into_inner(), true));
            }
            for event in events_of(failed) {
                served.push((event.topics[1].0, false));
            }
            let processed = served.len() as u32;
            (Outcome::Cranked { height, processed }, served)
        }
    }
}

// A trader makes `TRADES` swaps, one at a time, idling a random number of blocks
// between them.
//
// For each it submits a swap request through the router, then waits until the
// pool reports the request served. Unless a keeper does the cranking, it also
// cranks the queue (when depends on `cranking`), and cranks again whenever its
// last crank has landed and the request is still waiting.
fn trader(name: &'static str, cranking: Cranking, ledger: SharedLedger) -> Agent {
    Agent::new(name, move |mut ctx| async move {
        let me = ctx.address();
        let cfg = join(&mut ctx).await?;
        let tokens = [
            ERC20Client::new(&ctx, cfg.token0),
            ERC20Client::new(&ctx, cfg.token1),
        ];
        let router = SwapRouterClient::new(&ctx, cfg.router);
        let driver = SwapDriverClient::new(&ctx, cfg.driver);

        // Let the handler take whatever we trade, for the whole run.
        for token in &tokens {
            token.adjust_allowance(&cfg.handler, TRADER_FUNDS).await?;
        }
        ctx.send("admin", &())?;

        let mut trades_left = TRADES;
        // The current swap request and our latest crank, as indices into the
        // ledger, until each is finished with.
        let mut request: Option<usize> = None;
        let mut crank: Option<usize> = None;
        loop {
            next_block(&mut ctx).await?;
            {
                let ledger = lock(&ledger);
                crank = crank.filter(|&c| !ledger.landed(c));
                request = request.filter(|&r| !ledger.is_served(r));
            }

            if request.is_none() && trades_left > 0 && ctx.rng().next_u64() % 2 == 0 {
                // Swap a random direction, naming either the input or the output.
                let into = (ctx.rng().next_u64() % 2) as usize;
                let (token_in, token_out) = (tokens[1 - into].address(), tokens[into].address());
                let call = if ctx.rng().next_u64() % 2 == 0 {
                    router.swap_exact_tokens_for_tokens(
                        swap_amount(TRADE_SIZE),
                        0,
                        &token_in,
                        &token_out,
                        &me,
                    )
                } else {
                    router.swap_tokens_for_exact_tokens(
                        swap_amount(TRADE_SIZE),
                        swap_amount(2 * TRADE_SIZE),
                        &token_in,
                        &token_out,
                        &me,
                    )
                };
                let submitted = call.submit().await?;
                submitted.await_pending().await?;
                request = Some(lock(&ledger).record(Kind::Request, submitted.tx_hash()));
                trades_left -= 1;
            }

            if let Some(r) = request
                && crank.is_none()
                && match cranking {
                    Cranking::AfterRequest => lock(&ledger).landed(r),
                    Cranking::WithRequest => true,
                    Cranking::Keeper => false,
                }
            {
                let submitted = driver.process_requests().submit().await?;
                submitted.await_pending().await?;
                crank = Some(lock(&ledger).record(Kind::Crank, submitted.tx_hash()));
            }

            let done = trades_left == 0 && request.is_none() && crank.is_none();
            ctx.send("chain", &done)?;
            if done {
                return Ok(());
            }
        }
    })
}

// The keeper cranks whenever a request is waiting and its last crank has
// landed, until every trade has been served.
fn keeper(ledger: SharedLedger) -> Agent {
    Agent::new(KEEPER, move |mut ctx| async move {
        let cfg = join(&mut ctx).await?;
        let driver = SwapDriverClient::new(&ctx, cfg.driver);
        ctx.send("admin", &())?;

        let mut crank: Option<usize> = None;
        loop {
            next_block(&mut ctx).await?;
            let (waiting, finished) = {
                let ledger = lock(&ledger);
                crank = crank.filter(|&c| !ledger.landed(c));
                (ledger.any_waiting(), ledger.all_served())
            };

            if waiting && crank.is_none() {
                let submitted = driver.process_requests().submit().await?;
                submitted.await_pending().await?;
                crank = Some(lock(&ledger).record(Kind::Crank, submitted.tx_hash()));
            }

            let done = finished && crank.is_none();
            ctx.send("chain", &done)?;
            if done {
                return Ok(());
            }
        }
    })
}

// Print what happened, block by block and request by request, and check that
// every swap request was served (successfully or not).
fn report(cranking: Cranking, ledger: &Ledger) {
    #[derive(Default)]
    struct Block {
        enqueued: u32,
        swapped: u32,
        failed: u32,
        cranks: u32,
        idle: u32,
        dropped: u32,
        refused: u32,
        held: u32,
    }
    let mut blocks: BTreeMap<i64, Block> = BTreeMap::new();
    for tx in &ledger.txs {
        let outcome = tx.outcome.expect("every transaction landed or was dropped");
        let block = blocks.entry(outcome.height()).or_default();
        match outcome {
            Outcome::Enqueued { .. } => block.enqueued += 1,
            Outcome::Cranked { processed, .. } => {
                block.cranks += 1;
                if processed == 0 {
                    block.idle += 1;
                }
            }
            Outcome::Reverted { .. } => block.refused += 1,
            Outcome::Dropped { .. } => block.dropped += 1,
        }
        block.held += tx.held;
    }
    for service in ledger.served.values() {
        let block = blocks.entry(service.height).or_default();
        if service.ok {
            block.swapped += 1;
        } else {
            block.failed += 1;
        }
    }

    println!("\n=== cranking: {cranking:?} ===");
    println!("\n      | requests |  swaps  |              cranks");
    println!("block | enqueued | ok fail | landed idle dropped refused held");
    for (height, b) in &blocks {
        println!(
            "{height:>5} | {:>8} | {:>2} {:>4} | {:>6} {:>4} {:>7} {:>7} {:>4}",
            b.enqueued, b.swapped, b.failed, b.cranks, b.idle, b.dropped, b.refused, b.held
        );
    }

    // Blocks from a request's submission to its service: 1 means the block it
    // was submitted for also served it.
    let mut latency: BTreeMap<i64, [u32; 2]> = BTreeMap::new();
    for i in ledger.requests() {
        let id = ledger.request_id(i).expect("every request was enqueued");
        let service = ledger.served.get(&id).expect("every request was served");
        latency
            .entry(service.height - ledger.txs[i].submitted_after)
            .or_default()[usize::from(!service.ok)] += 1;
    }
    println!("\nblocks to service | ok fail");
    for (blocks, [ok, failed]) in &latency {
        println!("{blocks:>17} | {ok:>2} {failed:>4}");
    }

    let sum = |f: fn(&Block) -> u32| blocks.values().map(f).sum::<u32>();
    println!(
        "\n{} swaps ({} failed) and {} cranks ({} idle, {} dropped, {} refused) in {} blocks",
        sum(|b| b.swapped + b.failed),
        sum(|b| b.failed),
        sum(|b| b.cranks + b.dropped + b.refused),
        sum(|b| b.idle),
        sum(|b| b.dropped),
        sum(|b| b.refused),
        blocks.len(),
    );
    assert_eq!(ledger.requests().count(), TRADERS.len() * TRADES);
}

async fn run(seed: &str, cranking: Cranking) {
    let Ok(root) = std::env::var("THRUPUT_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set THRUPUT_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };
    let artifact = |file: &str| PathBuf::from(&root).join(file);

    let mut config = LocalNetworkConfig::default();
    // The admin funds every contract it deploys (see CONTRACT_FUNDING).
    config.initial_account_tokens = 100_000_000_000;
    // The chain agent produces the blocks.
    config.block_driver = BlockDriverConfig::manual();
    if let Ok(bin) = std::env::var("THRUPUT_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }

    let scenario = Scenario::builder(seed)
        .network(NetworkConfig::local(config))
        .artifact("erc20", artifact("erc20.rv32a"))
        .artifact("swap_handler", artifact("swap_handler.rv32a"))
        .artifact("swap_driver", artifact("swap_driver.rv32a"))
        .artifact("swap_router", artifact("swap_router.rv32a"))
        .artifact("swap_factory", artifact("swap_factory.rv32a"))
        .build()
        .await
        .expect("local node starts with the swap artifacts registered");

    let ledger = SharedLedger::default();
    let mut participants = TRADERS.to_vec();
    if cranking == Cranking::Keeper {
        participants.push(KEEPER);
    }
    let mut agents = vec![
        chain(participants.clone(), ledger.clone()),
        admin(participants),
    ];
    agents.extend(
        TRADERS
            .iter()
            .map(|&name| trader(name, cranking, ledger.clone())),
    );
    if cranking == Cranking::Keeper {
        agents.push(keeper(ledger.clone()));
    }
    scenario
        .run_agents(agents)
        .await
        .expect("the agents finish");

    report(cranking, &lock(&ledger));
}

#[tokio::test]
#[ignore = "needs built swap fixtures in THRUPUT_TESTKIT_ARTIFACT_ROOT"]
async fn swap_cranking_after_request() {
    run("swap-crank-after", Cranking::AfterRequest).await;
}

#[tokio::test]
#[ignore = "needs built swap fixtures in THRUPUT_TESTKIT_ARTIFACT_ROOT"]
async fn swap_cranking_with_request() {
    run("swap-crank-with", Cranking::WithRequest).await;
}

#[tokio::test]
#[ignore = "needs built swap fixtures in THRUPUT_TESTKIT_ARTIFACT_ROOT"]
async fn swap_cranking_by_keeper() {
    run("swap-crank-keeper", Cranking::Keeper).await;
}
