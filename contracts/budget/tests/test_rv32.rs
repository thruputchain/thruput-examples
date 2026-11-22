use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::time::Duration;

use budget::*;
use erc20::{ERC20Client, ERC20MetadataClient};
use thruput_sdk::*;

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/budget.rv32a")
}

const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;

// Seven units an hour, up to ten: a refill credits whole units on a grid that does not divide a
// second evenly.
const SLOW: Limit = Limit {
    burst: 10,
    refill: 7,
    period: 3_600,
};

/// The budget run as RV32 in the executor, as it runs on chain: concurrent spends that the shared
/// bucket trims, an exact refill at an irregular moment, a revoke in the same block as a spend,
/// and a forget.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn spends_refills_and_revokes_in_the_guest() {
    let env = TestEnvironment::no_cost();
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let token_code = erc20::register_mock_contract(&env);
    env.advance_block_at(START.into());
    env.set_block_time_step(Some(Duration::from_secs(1)));
    let owner = ContractAddress::named("owner");
    let agents: Vec<_> = (0..4)
        .map(|i| ContractAddress::named(&format!("agent-{i}")))
        .collect();
    let vendor = ContractAddress::named("vendor");

    let (mut budget, mut token) = (owner, owner);
    env.transact(|tx| {
        tx.call(&owner).run(AssertUnwindSafe(|| {
            token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
            ERC20MetadataClient::new(&token).initialize(&owner, None, None, Some(2));
            budget = deploy_contract(&sha256_static!("budget"), &code);
            let c = BudgetClient::new(&budget);
            // Together, the agents may spend 25 at once.
            c.initialize(
                &token,
                Limit {
                    burst: 25,
                    refill: 0,
                    period: 1,
                },
            );
            ERC20Client::new(&token).mint(&budget, 1_000);
            for agent in &agents {
                c.grant(agent, SLOW, None);
            }
        }))
    })
    .assert_success();
    env.advance_block();

    // Every agent spends its whole burst in one block: the first two fit the shared bucket, and
    // the runtime turns away the rest.
    let mut txs: Vec<_> = agents
        .iter()
        .map(|agent| {
            let mut tx = env.transaction().build();
            tx.call(agent)
                .run(move || BudgetClient::new(&budget).spend(&vendor, 10))
                .assert_success();
            tx
        })
        .collect();
    let admitted = txs
        .iter_mut()
        .map(|tx| tx.try_commit_transaction())
        .filter(|result| *result == TryCommitResult::Ok)
        .count();
    drop(txs);
    assert_eq!(admitted, 2);
    env.advance_block();

    // Lift the shared limit, so that it no longer hides the agents' own buckets: from its next
    // refill, the shared bucket is full.
    env.transact(|tx| {
        tx.call(&owner).run(move || {
            BudgetClient::new(&budget).set_limit(Limit {
                burst: 1_000,
                refill: 1_000,
                period: 1,
            })
        })
    })
    .assert_success();

    // At an irregular moment, 2,000.12 seconds after the buckets were filled, the two agents that
    // spent have refilled by exactly the units that arrived in between. That is four, though
    // 2,000 seconds at seven an hour is 3.89: units arrive at fixed moments 514.29 seconds apart,
    // and the buckets were filled 0.78 of the way to the next one. The agents the runtime turned
    // away kept nothing of their spends, so their buckets are still full.
    env.advance_block_at((START + 2_000 * SECOND + 123_456_789).into());
    let available = |who: ContractAddress| {
        let r = env.transact(|tx| {
            tx.call(&owner)
                .run(move || BudgetClient::new(&budget).available(&who))
        });
        r.assert_success();
        r.assert_return_as::<i128>()
    };
    let (first, second) = (agents[0], agents[1]);
    assert_eq!(available(first), 4);
    assert_eq!(available(second), 4);
    assert_eq!(available(agents[2]), 10);

    // The first agent spends all four, and the owner revokes it in the same block, without
    // conflicting with the spend.
    let mut spend = env.transaction().build();
    spend
        .call(&first)
        .run(move || BudgetClient::new(&budget).spend(&vendor, 4))
        .assert_success();
    let mut revoke = env.transaction().build();
    revoke
        .call(&owner)
        .run(move || BudgetClient::new(&budget).revoke(&first))
        .assert_success();
    assert_eq!(revoke.try_commit_transaction(), TryCommitResult::Ok);
    assert_eq!(spend.try_commit_transaction(), TryCommitResult::Ok);
    drop((spend, revoke));
    env.advance_block();

    let paid = env.transact(|tx| {
        tx.call(&owner).run(move || {
            let c = BudgetClient::new(&budget);
            c.forget(&first);
            assert_eq!(c.available(&first), 0);
            assert_eq!(c.available(&second), 4);
            ERC20Client::new(&token).get_balance_of(&vendor)
        })
    });
    paid.assert_success();
    assert_eq!(paid.assert_return_as::<i128>(), 24);
}
