//! Put `run` transactions into blocks by hand and report what became of them.
//!
//! Two agents, `lead` and `rival`, each submit `run` from their own account; the
//! lead then produces the block and reads both outcomes. Two transactions in a
//! block race, so each case is run for `ROUNDS` blocks, and the test prints how
//! often it came out each way. Unless noted, every `run` makes three
//! commit-locked `bump` calls on the same counter:
//!
//! | case                        | transactions in the block                        |
//! |-----------------------------|--------------------------------------------------|
//! | `alone`                     | lead only                                        |
//! | `disjoint`                  | lead and rival, on different counters            |
//! | `contested`                 | lead and rival                                   |
//! | `contested-1`               | lead, and rival making only one call             |
//! | `contested-blind`           | lead and rival, writing with `put` (no read)     |
//! | `contested-unlocked`        | lead and rival, without commit locking           |
//! | `contested-claimed`         | lead and rival, each first claiming exclusively  |
//! | `contested-unlocked-claimed`| the same, without commit locking                 |
//!
//! `contested-claimed` is the shape of two competing batch cranks: the claim
//! makes one of the two transactions conflict at commit and be dropped, and the
//! other should then commit with every call succeeded. The test asserts that
//! in every block, as well as the controls (`alone`, `disjoint`,
//! `contested-unlocked-claimed`), once the tally has been printed. The other
//! cases are printed only, to help pin down the cause.
//!
//! One run on `hog-devnode` 0.1.31-rc.11. Each outcome is the set of the
//! block's fates, as bitmasks of the calls that succeeded and faulted (7 is all
//! three); the proportions vary from run to run:
//!
//! ```text
//! case                        outcome (of 10 blocks)
//! alone                       10 x  ok=7 fault=0
//! disjoint                    10 x  ok=7 fault=0 / ok=7 fault=0
//! contested                   10 x  ok=1 fault=6 / ok=1 fault=6
//! contested-1                  9 x  ok=1 fault=0 / ok=1 fault=6
//!                              1 x  ok=0 fault=1 / ok=7 fault=0
//! contested-blind              7 x  ok=1 fault=6 / ok=1 fault=6
//!                              1 x  ok=4 fault=3 / ok=7 fault=0
//!                              2 x  ok=0 fault=7 / ok=7 fault=0
//! contested-unlocked          10 x  ok=7 fault=0 / ok=7 fault=0
//! contested-claimed            9 x  ok=1 fault=6 / dropped
//!                              1 x  ok=7 fault=0 / dropped
//! contested-unlocked-claimed  10 x  ok=7 fault=0 / dropped
//! ```
//!
//! The contested outcomes come in three shapes, which `tests/mock.rs`
//! reproduces by running the two transactions' calls in a chosen order. A
//! commit-locked write succeeds only if every other transaction holding a lock
//! on the key holds it with the same value, and locks are held until the
//! holding transaction ends:
//!
//! * `ok=0 fault=7 / ok=7 fault=0`: one transaction made all its calls first,
//!   so it held the counter at 3 when the other wrote 1, 2 and 3.
//! * `ok=1 fault=6 / ok=1 fault=6`, the most common: the calls interleaved, so
//!   both first calls wrote 1 and both transactions held the counter; every
//!   later write disagreed with the other's value.
//! * `ok=4 fault=3 / ok=7 fault=0`, rarely, with blind writes: the faulting
//!   transaction's last `put(2)` happened to match the value the other held.
//!
//! `contested-claimed` is usually the second shape, even though the other
//! transaction is dropped at commit: it held the counter while it executed.
//!
//! ```shell
//! thruput build -p commit-lock-conflict
//! THRUPUT_TESTKIT_ARTIFACT_ROOT="${PWD}/target/thruput" \
//! THRUPUT_DEVNODE_BINARY="$(thruput toolchain which)" \
//!     cargo test -p commit-lock-conflict --test live -- --ignored --no-capture
//! ```

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use thruput_json_rpc_types::base58::Base58;
use thruput_json_rpc_types::responses::{ReceiptExecution, TransactionStatus};
use thruput_json_rpc_types::transaction::TxHash;
use thruput_testkit::xdr::types::{ContractAddress, SHA256Hash};
use thruput_testkit::{
    Agent, AgentContext, BlockDriverConfig, Contract, DeployOptions, LocalNetworkConfig, Network,
    NetworkConfig, Result, Scenario, xdrs,
};

// Calls each `run` makes, unless a case says otherwise.
const CALLS: u32 = 3;

// Blocks each case is run for. Two transactions in a block race, so one block
// shows only one way the race can go.
const ROUNDS: usize = 10;

// Native tokens each instance is funded with, to pay for its storage.
const FUNDING: u128 = 1_000_000_000;

fn probe(address: ContractAddress) -> Contract {
    Contract::new(address, "Probe", "0.1.0")
}

/// The arguments to one `run` (see `Probe::run`).
#[derive(Debug, Clone, Copy, xdrs::WriteXDR, xdrs::ReadXDR)]
#[xdr(crate = "thruput_testkit::xdrs")]
struct Run {
    target: ContractAddress,
    calls: u32,
    commit_locking: bool,
    blind: bool,
    claim: bool,
}

/// What became of one `run` transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Fate {
    /// Committed, with the bitmasks `run` returned: the calls that succeeded,
    /// and those that faulted.
    Committed { succeeded: u32, faulted: u32 },
    /// Dropped from the block for a commit conflict (`Retry`, code 3).
    Dropped,
}

impl std::fmt::Display for Fate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Fate::Committed { succeeded, faulted } => write!(f, "ok={succeeded} fault={faulted}"),
            Fate::Dropped => write!(f, "dropped"),
        }
    }
}

// A block's fates, in a canonical order: which agent's transaction survives a
// conflict is up to the node, so the outcome is the set of fates.
fn outcome(mut fates: Vec<Fate>) -> String {
    fates.sort();
    let fates: Vec<String> = fates.iter().map(Fate::to_string).collect();
    fates.join(" / ")
}

// Committed, with all of `calls` calls succeeded.
const fn full(calls: u32) -> Fate {
    Fate::Committed {
        succeeded: (1 << calls) - 1,
        faulted: 0,
    }
}

// Submit `run` from `ctx`'s account and wait until the node holds it pending.
async fn submit(ctx: &AgentContext, outer: ContractAddress, run: &Run) -> Result<TxHash> {
    let args = (
        run.target,
        run.calls,
        run.commit_locking,
        run.blind,
        run.claim,
    );
    let submitted = probe(outer)
        .prepare_call::<(u32, u32), _>(ctx, "run", &args)
        .submit()
        .await?;
    submitted.await_pending().await?;
    Ok(submitted.tx_hash())
}

// Read what the block just produced did with `hash`.
async fn fate(network: &Network, hash: TxHash) -> Result<Fate> {
    match network.transaction_status(hash).await? {
        TransactionStatus::Committed { .. } => {
            let receipt = network.await_receipt(hash).await?;
            let ReceiptExecution::Return { return_data } = &receipt.execution else {
                panic!("run did not return: {:?}", receipt.execution);
            };
            let returned = thruput_signing::default_wallet::decode_default_wallet_call_return(
                return_data.as_ref(),
            )
            .expect("unwrapping the wallet's return");
            let (succeeded, faulted) = xdrs::cxs::decode(&returned).expect("decoding run's return");
            Ok(Fate::Committed { succeeded, faulted })
        }
        TransactionStatus::Retry { error, .. } if error.code == 3 => Ok(Fate::Dropped),
        other => panic!("unexpected status for {hash:?}: {other:?}"),
    }
}

// The rival submits whatever `run` the lead asks for, and reports its hash.
// (If the lead stops early, its own error is the one to report.)
fn rival() -> Agent {
    Agent::new("rival", |mut ctx| async move {
        let Some(outer) = ctx.recv_from::<ContractAddress>("lead").await else {
            return Ok(());
        };
        let outer = outer?.body;
        while let Some(run) = ctx.recv_from::<Option<Run>>("lead").await {
            let Some(run) = run?.body else {
                break;
            };
            let hash = submit(&ctx, outer, &run).await?;
            ctx.send("lead", &hash.0.0)?;
        }
        Ok(())
    })
}

/// Each block's case and outcome.
type Outcomes = Arc<Mutex<Vec<(&'static str, String)>>>;

// The lead deploys the instances, then runs each case for `ROUNDS` blocks.
fn lead(outcomes: Outcomes) -> Agent {
    Agent::new("lead", move |mut ctx| async move {
        let network = ctx.network().clone();

        // Produce blocks continually while deploying.
        let pumping = Arc::new(AtomicBool::new(true));
        let pump = tokio::spawn({
            let (network, pumping) = (network.clone(), pumping.clone());
            async move {
                while pumping.load(Ordering::Relaxed) {
                    network.produce_block().await.expect("producing a block");
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        });
        let mut deploy = async || -> Result<ContractAddress> {
            let options = DeployOptions::funded(FUNDING);
            Ok(ctx.deploy_artifact("probe", options).await?.address)
        };
        let outer = deploy().await?;
        let inner = deploy().await?;
        let other = deploy().await?;
        pumping.store(false, Ordering::Relaxed);
        pump.await.expect("the block pump finishes");

        ctx.send("rival", &outer)?;

        let run = Run {
            target: inner,
            calls: CALLS,
            commit_locking: true,
            blind: false,
            claim: false,
        };
        let cases: [(&str, Run, Option<Run>); 8] = [
            ("alone", run, None),
            (
                "disjoint",
                run,
                Some(Run {
                    target: other,
                    ..run
                }),
            ),
            ("contested", run, Some(run)),
            ("contested-1", run, Some(Run { calls: 1, ..run })),
            (
                "contested-blind",
                Run { blind: true, ..run },
                Some(Run { blind: true, ..run }),
            ),
            (
                "contested-unlocked",
                Run {
                    commit_locking: false,
                    ..run
                },
                Some(Run {
                    commit_locking: false,
                    ..run
                }),
            ),
            (
                "contested-claimed",
                Run { claim: true, ..run },
                Some(Run { claim: true, ..run }),
            ),
            (
                "contested-unlocked-claimed",
                Run {
                    commit_locking: false,
                    claim: true,
                    ..run
                },
                Some(Run {
                    commit_locking: false,
                    claim: true,
                    ..run
                }),
            ),
        ];

        for (label, ours, theirs) in cases {
            for _ in 0..ROUNDS {
                let mut hashes = vec![submit(&ctx, outer, &ours).await?];
                if let Some(theirs) = theirs {
                    ctx.send("rival", &Some(theirs))?;
                    let hash: SHA256Hash =
                        ctx.recv_from("rival").await.expect("rival closed")?.body;
                    hashes.push(TxHash(Base58(hash)));
                }

                network.produce_block().await?;
                let mut fates = Vec::new();
                for hash in hashes {
                    fates.push(fate(&network, hash).await?);
                }
                outcomes.lock().unwrap().push((label, outcome(fates)));
            }
        }
        ctx.send("rival", &None::<Run>)?;
        Ok(())
    })
}

#[tokio::test]
#[ignore = "needs a built probe in THRUPUT_TESTKIT_ARTIFACT_ROOT"]
async fn dropped_transaction_spoils_commit_locked_calls() {
    let Ok(root) = std::env::var("THRUPUT_TESTKIT_ARTIFACT_ROOT") else {
        eprintln!("skipping: set THRUPUT_TESTKIT_ARTIFACT_ROOT (see module docs)");
        return;
    };

    let mut config = LocalNetworkConfig::default();
    // The lead funds each instance it deploys (see FUNDING).
    config.initial_account_tokens = 100_000_000_000;
    // The lead produces the blocks.
    config.block_driver = BlockDriverConfig::manual();
    if let Ok(bin) = std::env::var("THRUPUT_DEVNODE_BINARY") {
        config.hog_devnode_binary = Some(bin.into());
    }
    let scenario = Scenario::builder("commit-lock-conflict")
        .network(NetworkConfig::local(config))
        .artifact(
            "probe",
            PathBuf::from(root).join("commit_lock_conflict.rv32a"),
        )
        .build()
        .await
        .expect("local node starts with the probe registered");

    let outcomes = Outcomes::default();
    scenario
        .run_agents([lead(Arc::clone(&outcomes)), rival()])
        .await
        .expect("the agents finish");

    // How often each case came out each way, in the order the cases ran.
    let outcomes = outcomes.lock().unwrap();
    let mut tally: Vec<(&str, Vec<(&str, usize)>)> = Vec::new();
    for (label, outcome) in outcomes.iter() {
        if tally.last().is_none_or(|(l, _)| l != label) {
            tally.push((label, Vec::new()));
        }
        let counts = &mut tally.last_mut().unwrap().1;
        match counts.iter_mut().find(|(o, _)| o == outcome) {
            Some((_, n)) => *n += 1,
            None => counts.push((outcome, 1)),
        }
    }
    println!("\ncase                        outcome (of {ROUNDS} blocks)");
    for (label, counts) in &tally {
        for (i, (outcome, n)) in counts.iter().enumerate() {
            let label = if i == 0 { label } else { "" };
            println!("{label:<26}  {n:>2} x  {outcome}");
        }
    }

    // In every block, a transaction that commits has every call succeed.
    let full = full(CALLS);
    let expected = [
        ("alone", outcome(vec![full])),
        ("disjoint", outcome(vec![full, full])),
        ("contested-claimed", outcome(vec![full, Fate::Dropped])),
        (
            "contested-unlocked-claimed",
            outcome(vec![full, Fate::Dropped]),
        ),
    ];
    let mut wrong = Vec::new();
    for (label, want) in &expected {
        let got = outcomes.iter().filter(|(l, _)| l == label);
        let bad = got.clone().filter(|(_, o)| o != want).count();
        if bad > 0 {
            wrong.push(format!(
                "{label}: expected {want}, but not in {bad} of {} blocks",
                got.count()
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "unexpected outcomes:\n{}",
        wrong.join("\n")
    );
}
