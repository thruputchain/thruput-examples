use budget::*;
use erc20::{ERC20Client, ERC20MetadataClient};
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

// Blocks are a second apart, from START.
const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;

// What the owner funds the budget with.
const FUNDS: i128 = 1_000_000;

// The native tokens each party starts with when storage is priced.
const NATIVE: i128 = 100_000_000;

// A unit a second, up to a hundred.
const PER_SECOND: Limit = Limit {
    burst: 100,
    refill: 60,
    period: 60,
};

// More than any test spends: a shared limit that never binds.
const UNLIMITED: Limit = Limit {
    burst: FUNDS,
    refill: FUNDS,
    period: 1,
};

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn names(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}-{i}")).collect()
}

#[derive(Clone, Copy)]
enum Storage {
    Free,
    Priced,
}

struct Fixture {
    env: TestEnvironmentHandle,
    _codes: [MockContract; 2],
    budget: ContractAddress,
    token: ContractAddress,
}

impl Fixture {
    // A budget for `FUNDS` tokens, under the shared `limit`, deployed and funded by the owner.
    // Returns in the next block.
    fn new(limit: Limit) -> Self {
        Self::with_storage(limit, Storage::Free)
    }

    fn with_storage(limit: Limit, storage: Storage) -> Self {
        let env = match storage {
            Storage::Free => TestEnvironment::no_cost(),
            Storage::Priced => TestEnvironment::default(),
        };
        let owner = addr("owner");
        if let Storage::Priced = storage {
            // The native token pays for its own balance rows, like any token.
            for who in [&owner, &ADDRESS_NATIVE_TOKEN] {
                env.setup_grant_storage_tokens(who, NATIVE as i64);
            }
        }
        env.advance_block_at(START.into());
        env.set_block_time_step(Some(Duration::from_secs(1)));

        let code = register_mock_contract(&env);
        let token_code = erc20::register_mock_contract(&env);
        let native = ERC20Client::new(&ADDRESS_NATIVE_TOKEN);
        let reserve = match storage {
            Storage::Free => 0,
            Storage::Priced => NATIVE / 10,
        };

        let (mut budget, mut token) = (owner, owner);
        env.transact(|tx| {
            tx.call(&owner).run(AssertUnwindSafe(|| {
                token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
                if reserve > 0 {
                    native.transfer(&token, reserve);
                }
                ERC20MetadataClient::new(&token).initialize(&owner, None, None, Some(2));

                // Deploy and start the budget in one transaction, so nobody can start it first.
                budget = deploy_contract(&sha256_static!("budget"), code.as_hash());
                if reserve > 0 {
                    native.transfer(&budget, reserve);
                }
                BudgetClient::new(&budget).initialize(&token, limit);
                ERC20Client::new(&token).mint(&budget, FUNDS);
            }))
        })
        .assert_success();
        env.advance_block();

        Self {
            env,
            _codes: [code, token_code],
            budget,
            token,
        }
    }

    // Run `f` against the budget as `caller`, in the current block, and require it to succeed.
    fn call<R>(&self, caller: &str, f: impl FnOnce(BudgetClient) -> R) -> R
    where
        R: WriteXDR + xdr::ReadXDROwned,
    {
        let budget = self.budget;
        let result = self.env.transact(|tx| {
            tx.call(&addr(caller))
                .run(AssertUnwindSafe(|| f(BudgetClient::new(&budget))))
        });
        result.assert_success();
        result.assert_return_as::<R>()
    }

    // The budget error the call `f` makes fails with, as `caller`. `f` returns the call's error:
    // `|c| c.try_spend(&to, 1).err()`.
    fn refused(
        &self,
        caller: &str,
        f: impl FnOnce(BudgetClient) -> Option<CallError>,
    ) -> BudgetError {
        let budget = self.budget;
        let mut error = None;
        self.env
            .transact(|tx| {
                tx.call(&addr(caller)).run(AssertUnwindSafe(|| {
                    error = f(BudgetClient::new(&budget));
                }))
            })
            .assert_success();
        error
            .expect("the call succeeded")
            .try_as::<BudgetError>()
            .expect("a budget error")
    }

    fn grant(&self, spender: &str, limit: Limit) {
        let spender = addr(spender);
        self.call("owner", |c| c.grant(&spender, limit, None));
    }

    // Spend, as `spender`, to `to`, and require it to commit.
    fn spend(&self, spender: &str, to: &str, amount: i128) {
        let to = addr(to);
        self.call(spender, |c| c.spend(&to, amount));
    }

    // Execute `spender`'s spend in the current block without committing it.
    fn pending_spend(&self, spender: &str, to: &str, amount: i128) -> MockTransactionHandler {
        let (budget, to) = (self.budget, addr(to));
        let mut tx = self.env.transaction().build();
        tx.call(&addr(spender))
            .run(move || BudgetClient::new(&budget).spend(&to, amount))
            .assert_success();
        tx
    }

    fn available(&self, spender: &str) -> i128 {
        let spender = addr(spender);
        self.call("viewer", |c| c.available(&spender))
    }

    fn shared_available(&self) -> i128 {
        self.call("viewer", |c| c.shared_available())
    }

    fn balance_in(&self, token: ContractAddress, holder: ContractAddress) -> i128 {
        let r = self.env.transact(|tx| {
            tx.call(&addr("viewer"))
                .run(move || ERC20Client::new(&token).get_balance_of(&holder))
        });
        r.assert_success();
        r.assert_return_as::<i128>()
    }

    fn balance(&self, holder: &str) -> i128 {
        self.balance_in(self.token, addr(holder))
    }

    fn held(&self) -> i128 {
        self.balance_in(self.token, self.budget)
    }
}

// Commit `txs` in order, and return how each fared.
fn commit_all(txs: Vec<MockTransactionHandler>) -> Vec<TryCommitResult> {
    let mut txs = txs;
    let results = txs
        .iter_mut()
        .map(|tx| tx.try_commit_transaction())
        .collect();
    drop(txs);
    results
}

// The codes of the conflicts that kept a transaction out of its block.
fn conflicts(result: &TryCommitResult) -> Vec<DbConflictCode> {
    match result {
        TryCommitResult::TxNonDeterministicError(DbConflictResult::kDbDiagnosticAll {
            conflicts,
        }) => conflicts.iter().map(|c| c.code).collect(),
        TryCommitResult::TxNonDeterministicError(DbConflictResult::kDbDiagnosticFirst {
            first,
        }) => vec![first.code],
        other => panic!("expected a conflict, got {other:?}"),
    }
}

fn admitted(results: &[TryCommitResult]) -> usize {
    results
        .iter()
        .filter(|r| **r == TryCommitResult::Ok)
        .count()
}

// A bucket holds its burst, and after that refills at its rate, up to its burst again.
#[test]
fn a_spender_spends_its_burst_then_what_flows_back() {
    let f = Fixture::new(UNLIMITED);
    f.grant("alice", PER_SECOND);
    f.env.advance_block();
    assert_eq!(f.available("alice"), 100);

    // Two spends in one block, which do not see each other, together take the whole burst.
    f.spend("alice", "shop", 70);
    f.spend("alice", "shop", 30);
    // A third in the same block finds the bucket full as of the block's start, so it gets past
    // the contract's own check. The runtime turns it away: the block has taken all there was.
    let third = commit_all(vec![f.pending_spend("alice", "shop", 1)]);
    assert_eq!(conflicts(&third[0]), vec![DbConflictCode::BoundsExceeded]);
    f.env.advance_block();
    assert_eq!(f.balance("shop"), 100);

    // A second later, a unit has flowed back.
    assert_eq!(f.available("alice"), 1);
    let shop = addr("shop");
    assert_eq!(
        f.refused("alice", |c| c.try_spend(&shop, 2).err()),
        BudgetError::OverSpenderLimit
    );
    f.spend("alice", "shop", 1);
    f.env.advance_block();
    assert_eq!(f.available("alice"), 1);

    // An idle bucket fills up to its burst, and no further.
    f.env.advance_block_at((START + 3_600 * SECOND).into());
    assert_eq!(f.available("alice"), 100);

    // One transaction's spends see each other: a batch of payments refills the bucket once, and
    // the contract refuses the payment that would overdraw it.
    let (a, b) = (addr("a"), addr("b"));
    let over = f.call("alice", |c| {
        c.spend(&a, 60);
        c.spend(&b, 40);
        c.try_spend(&a, 1).unwrap_err().try_as() == Some(BudgetError::OverSpenderLimit)
    });
    assert!(over);
    f.env.advance_block();
    assert_eq!((f.balance("a"), f.balance("b")), (60, 40));
    assert_eq!(f.held(), FUNDS - 201);
}

// Refill a bucket at the given times, never spending, and check after each that it holds exactly
// what flowed in since the start, rounded down once.
fn refill_at(limit: &Limit, times: impl IntoIterator<Item = u64>) {
    let (mut held, mut counted_to) = (0, 0);
    for now in times {
        if let Some(refilled) = refill(limit, held, counted_to, now) {
            (held, counted_to) = (refilled, now);
        }
        let flowed = (limit.refill as u128 * u128::from(now)
            / (u128::from(limit.period) * u128::from(SECOND))) as i128;
        assert_eq!(held, flowed.min(limit.burst), "at {now}");
    }
}

// Units flow in at fixed moments, and a refill credits the ones it has passed, so no fraction of
// a unit is lost between refills: refills however often add up to one refill over the whole time.
#[test]
fn refills_add_up_however_often_they_happen() {
    // Seven units an hour: a unit every 514 seconds and change.
    let slow = Limit {
        burst: 1_000,
        refill: 7,
        period: 3_600,
    };
    // A refill in every block, a second apart, for a day.
    refill_at(&slow, (0..86_400).map(|s| s * SECOND));
    // At irregular times, down to the nanosecond.
    refill_at(&slow, (0..5_000u64).map(|i| i * i * 7_919_993 + i % 3));

    // A huge rate, against a small period, still fills only to the burst.
    let fast = Limit {
        burst: i128::MAX,
        refill: i128::MAX,
        period: 1,
    };
    assert_eq!(refill(&fast, 0, 0, u64::MAX), Some(i128::MAX));

    // A full bucket is recorded as full, which moves its count to now: the time it spent full is
    // not saved up.
    assert_eq!(refill(&PER_SECOND, 100, 0, 50 * SECOND), Some(100));
    // A bucket with no refill never refills.
    let once = Limit {
        refill: 0,
        ..PER_SECOND
    };
    assert_eq!(refill(&once, 40, 0, u64::MAX), None);
}

const CROWD: usize = 50;

// A hundred spends -- two each from fifty spenders -- in one block, each executed before any
// commits, committed in the order `order` gives.
fn crowd_spends(order: impl Iterator<Item = usize>) -> Fixture {
    let f = Fixture::new(Limit {
        burst: 10_000,
        refill: 0,
        period: 1,
    });
    let spenders = names("agent", CROWD);
    for spender in &spenders {
        f.grant(spender, PER_SECOND);
    }
    f.env.advance_block();

    let mut txs: Vec<_> = (0..2 * CROWD)
        .map(|i| {
            Some(f.pending_spend(
                &spenders[i / 2],
                &format!("vendor-{}", i % 7),
                1 + i as i128 % 40,
            ))
        })
        .collect();
    for i in order {
        let mut tx = txs[i].take().unwrap();
        assert_eq!(
            tx.try_commit_transaction(),
            TryCommitResult::Ok,
            "spend {i}"
        );
    }
    drop(txs);
    f.env.advance_block();
    f
}

// Spends from different spenders, and from one spender twice, all land in one block: they share
// both the shared bucket and the token's balance of the budget, and never conflict over either.
// The order they commit in makes no difference.
#[test]
fn a_hundred_spends_land_in_one_block_in_any_order() {
    let forward = crowd_spends(0..2 * CROWD);
    let backward = crowd_spends((0..2 * CROWD).rev());

    let paid: i128 = (0..2 * CROWD as i128).map(|i| 1 + i % 40).sum();
    for f in [&forward, &backward] {
        assert_eq!(f.held(), FUNDS - paid);
        assert_eq!(f.shared_available(), 10_000 - paid);
        let vendors: i128 = (0..7).map(|v| f.balance(&format!("vendor-{v}"))).sum();
        assert_eq!(vendors, paid);
    }
    for spender in names("agent", CROWD) {
        assert_eq!(forward.available(&spender), backward.available(&spender));
    }
}

// The shared bucket bounds every spender together. When a block's spends ask for more than it
// holds, the runtime admits them while they fit, and turns the rest away.
#[test]
fn the_shared_limit_trims_a_block_that_asks_too_much() {
    let f = Fixture::new(Limit {
        burst: 100,
        refill: 0,
        period: 1,
    });
    let spenders = names("agent", 20);
    for spender in &spenders {
        f.grant(
            spender,
            Limit {
                burst: 50,
                ..PER_SECOND
            },
        );
    }
    f.env.advance_block();

    let txs = spenders
        .iter()
        .map(|s| f.pending_spend(s, "vendor", 10))
        .collect();
    let results = commit_all(txs);
    assert_eq!(admitted(&results), 10);
    for result in &results[10..] {
        assert_eq!(conflicts(result), vec![DbConflictCode::BoundsExceeded]);
    }
    f.env.advance_block();
    assert_eq!(f.balance("vendor"), 100);

    // The shared bucket never refills, so from now on every spend is refused outright, though
    // each spender's own bucket still holds plenty.
    assert_eq!(f.available("agent-19"), 0);
    let vendor = addr("vendor");
    assert_eq!(
        f.refused("agent-19", |c| c.try_spend(&vendor, 1).err()),
        BudgetError::OverSharedLimit
    );
}

// One spender's spends from many sessions at once -- an agent working several tasks, say -- are
// bounded by its bucket in the same way.
#[test]
fn one_spender_from_many_sessions_at_once() {
    let f = Fixture::new(UNLIMITED);
    f.grant("alice", PER_SECOND);
    f.env.advance_block();

    let txs = (0..5)
        .map(|_| f.pending_spend("alice", "shop", 30))
        .collect();
    let results = commit_all(txs);
    assert_eq!(admitted(&results), 3);
    f.env.advance_block();
    assert_eq!(f.balance("shop"), 90);
}

// A revoke writes only the grant, which spends only read: it lands in the same block as the
// spender's spends, whichever commits first. The spender cannot hold it off.
#[test]
fn a_revoke_never_waits_for_spends() {
    let f = Fixture::new(UNLIMITED);
    let alice = addr("alice");
    for (round, spends_first) in [true, false].into_iter().enumerate() {
        f.grant("alice", PER_SECOND);
        f.env
            .advance_block_at((START + (1 + round as u64) * 600 * SECOND).into());

        let spend = f.pending_spend("alice", "shop", 40);
        let budget = f.budget;
        let mut revoke = f.env.transaction().build();
        revoke
            .call(&addr("owner"))
            .run(move || BudgetClient::new(&budget).revoke(&alice))
            .assert_success();
        let results = if spends_first {
            commit_all(vec![spend, revoke])
        } else {
            commit_all(vec![revoke, spend])
        };
        assert_eq!(results, vec![TryCommitResult::Ok, TryCommitResult::Ok]);
        f.env.advance_block();

        // The spend in the revoke's block counted. From the next block, there are none.
        let shop = addr("shop");
        assert_eq!(
            f.refused("alice", |c| c.try_spend(&shop, 1).err()),
            BudgetError::NotASpender
        );
        assert_eq!(f.available("alice"), 0);
        f.call("owner", |c| c.forget(&alice));
        f.env.advance_block();
    }
    assert_eq!(f.balance("shop"), 80);

    // A grant after a revoke starts over, with a full bucket.
    f.grant("alice", PER_SECOND);
    f.env.advance_block();
    assert_eq!(f.available("alice"), 100);
}

// A spender bound to a payee can pay nobody else: a stolen key can only pay the provider it was
// meant for, and only so fast.
#[test]
fn a_spender_with_a_payee_pays_only_it() {
    let f = Fixture::new(UNLIMITED);
    let (bot, api, thief) = (addr("bot"), addr("api"), addr("thief"));
    f.call("owner", |c| c.grant(&bot, PER_SECOND, Some(api)));
    f.env.advance_block();

    assert_eq!(
        f.refused("bot", |c| c.try_spend(&thief, 1).err()),
        BudgetError::WrongPayee
    );
    f.spend("bot", "api", 25);
    f.env.advance_block();
    assert_eq!(f.balance("api"), 25);
    assert_eq!(
        f.call("viewer", |c| c.grant_of(&bot)),
        Some(Grant {
            limit: PER_SECOND,
            payee: Some(api),
        })
    );
}

// The owner's changes to limits write only what spends read, so they land in the same block as
// spends. The spends in that block go by the old limits; later ones, by the new.
#[test]
fn changing_limits_never_conflicts_with_spends() {
    let f = Fixture::new(UNLIMITED);
    f.grant("alice", PER_SECOND);
    f.grant("bob", PER_SECOND);
    f.env.advance_block();

    let (budget, alice) = (f.budget, addr("alice"));
    let mut txs = vec![
        f.pending_spend("alice", "shop", 20),
        f.pending_spend("bob", "shop", 20),
    ];
    let mut change = f.env.transaction().build();
    change
        .call(&addr("owner"))
        .run(move || {
            let c = BudgetClient::new(&budget);
            c.grant(
                &alice,
                Limit {
                    burst: 50,
                    ..PER_SECOND
                },
                None,
            );
            c.set_limit(Limit {
                burst: 500,
                refill: 0,
                period: 1,
            });
        })
        .assert_success();
    txs.insert(1, change);
    assert_eq!(admitted(&commit_all(txs)), 3);
    f.env.advance_block();

    // Alice's bucket held 80 after her spend, which is more than her new burst of 50.
    assert_eq!(f.available("alice"), 50);
    assert_eq!(f.available("bob"), 81);
    // The shared bucket was full when its limit changed, and keeps up to its new burst.
    assert_eq!(f.shared_available(), 500);
}

// Only the owner grants, revokes, changes limits and withdraws.
#[test]
fn only_the_owner_manages_the_budget() {
    let f = Fixture::new(UNLIMITED);
    let mallory = addr("mallory");
    let refused = [
        f.refused("mallory", |c| c.try_grant(&mallory, PER_SECOND, None).err()),
        f.refused("mallory", |c| c.try_revoke(&mallory).err()),
        f.refused("mallory", |c| c.try_forget(&mallory).err()),
        f.refused("mallory", |c| c.try_set_limit(PER_SECOND).err()),
        f.refused("mallory", |c| c.try_withdraw(&mallory, 1).err()),
        f.refused("mallory", |c| c.try_spend(&mallory, 1).err()),
    ];
    let [grant, revoke, forget, set_limit, withdraw, spend] = refused;
    assert_eq!(grant, BudgetError::NotOwner);
    assert_eq!(revoke, BudgetError::NotOwner);
    assert_eq!(forget, BudgetError::NotOwner);
    assert_eq!(set_limit, BudgetError::NotOwner);
    assert_eq!(withdraw, BudgetError::NotOwner);
    assert_eq!(spend, BudgetError::NotASpender);

    f.call("owner", |c| c.withdraw(&addr("owner"), 1_000));
    f.env.advance_block();
    assert_eq!(f.balance("owner"), 1_000);
}

// Limits nobody could spend under are refused, a budget starts once, a grant is revoked before
// it is forgotten, and a spend must be positive.
#[test]
fn bad_arguments_are_refused() {
    let f = Fixture::new(UNLIMITED);
    let (alice, token) = (addr("alice"), f.token);
    let invalid = [
        Limit {
            burst: -1,
            ..PER_SECOND
        },
        Limit {
            refill: -1,
            ..PER_SECOND
        },
        Limit {
            period: 0,
            ..PER_SECOND
        },
    ];
    for limit in invalid {
        assert_eq!(
            f.refused("owner", |c| c.try_grant(&alice, limit, None).err()),
            BudgetError::InvalidLimit
        );
        assert_eq!(
            f.refused("owner", |c| c.try_set_limit(limit).err()),
            BudgetError::InvalidLimit
        );
    }
    assert_eq!(
        f.refused("owner", |c| c.try_initialize(&token, UNLIMITED).err()),
        BudgetError::AlreadyInitialized
    );
    assert_eq!(
        f.refused("owner", |c| c.try_revoke(&alice).err()),
        BudgetError::NotASpender
    );

    f.grant("alice", PER_SECOND);
    f.env.advance_block();
    assert_eq!(
        f.refused("owner", |c| c.try_forget(&alice).err()),
        BudgetError::StillGranted
    );
    let shop = addr("shop");
    assert_eq!(
        f.refused("alice", |c| c.try_spend(&shop, 0).err()),
        BudgetError::InvalidAmount
    );

    // A budget cannot pay out itself, or nothing.
    let env = TestEnvironment::no_cost();
    let code = register_mock_contract(&env);
    env.transact(|tx| {
        tx.call(&addr("owner")).run(AssertUnwindSafe(|| {
            let budget = deploy_contract(&sha256_static!("budget"), code.as_hash());
            let c = BudgetClient::new(&budget);
            for token in [budget, ContractAddress::default()] {
                assert_eq!(
                    c.try_initialize(&token, UNLIMITED).unwrap_err().try_as(),
                    Some(BudgetError::InvalidToken)
                );
            }
        }))
    })
    .assert_success();
}

// With storage priced as the network prices it, a grant costs the budget a deposit for each item
// it stores, and forgetting the spender returns them. Spends store nothing new -- they rewrite
// what the grant created -- so a block of them costs the budget no deposits at all.
#[test]
fn spends_store_nothing_new() {
    let f = Fixture::with_storage(UNLIMITED, Storage::Priced);
    let native = |f: &Fixture| f.balance_in(ADDRESS_NATIVE_TOKEN, f.budget);
    let before = native(&f);

    let spenders = names("agent", 10);
    for spender in &spenders {
        f.grant(spender, PER_SECOND);
    }
    f.env.advance_block();
    let granted = native(&f);
    assert!(granted < before, "grants are stored");

    let txs = (0..50)
        .map(|i| f.pending_spend(&spenders[i % 10], "vendor", 2))
        .collect();
    assert_eq!(admitted(&commit_all(txs)), 50);
    f.env.advance_block();
    assert_eq!(native(&f), granted);

    for spender in &spenders {
        let spender = addr(spender);
        f.call("owner", |c| c.revoke(&spender));
    }
    f.env.advance_block();
    for spender in &spenders {
        let spender = addr(spender);
        f.call("owner", |c| c.forget(&spender));
    }
    f.env.advance_block();
    assert_eq!(native(&f), before);
}
