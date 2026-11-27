use mutual_credit::*;
use std::panic::AssertUnwindSafe;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

// The native tokens each party starts with when a test needs them: plenty for bonds, and, when
// storage is priced, for the native token's own allowance rows.
const NATIVE: i128 = 100_000_000;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn names(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}-{i}")).collect()
}

fn route(via: &[&str], amount: i128) -> Route {
    Route {
        via: VecM(via.iter().map(|m| addr(m)).collect()),
        amount,
    }
}

fn routes(list: Vec<Route>) -> Routes {
    VecM(list)
}

// Whether storage is free, as in most of these tests, or priced as the network prices it.
#[derive(Clone, Copy)]
enum Storage {
    Free,
    Priced,
}

struct Network {
    env: TestEnvironmentHandle,
    _code: MockContract,
    credit: ContractAddress,
}

impl Network {
    // A network with no pair bond, on free storage. Returns in the block after it started.
    fn new() -> Self {
        Self::start(Storage::Free, 0, 0, &[])
    }

    // A network that asks `bond` of whoever opens a pair, and starts out holding `reserve` native
    // tokens. Each of `members` is given native tokens, and grants the network an allowance for its
    // bonds. Returns in the block after that.
    fn start(storage: Storage, bond: i128, reserve: i128, members: &[&str]) -> Self {
        let env = match storage {
            Storage::Free => TestEnvironment::no_cost(),
            Storage::Priced => TestEnvironment::default(),
        };
        let founder = addr("founder");
        // The native token pays for its own allowance rows, like any token.
        for who in members
            .iter()
            .map(|m| addr(m))
            .chain([founder, ADDRESS_NATIVE_TOKEN])
        {
            env.setup_grant_storage_tokens(&who, NATIVE as i64);
        }

        let code = register_mock_contract(&env);
        let hash = *code.as_hash();
        let deployed = env.transact(|tx| {
            tx.call(&founder).run(move || {
                // Deploy and start the network in one transaction, so nobody can start it first.
                let credit = deploy_contract(&sha256_static!("credit"), &hash);
                if reserve > 0 {
                    ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&credit, reserve);
                }
                MutualCreditClient::new(&credit).initialize(bond);
                credit
            })
        });
        deployed.assert_success();
        let credit = deployed.assert_return_as::<ContractAddress>();
        env.advance_block();

        if bond > 0 {
            for member in members {
                env.transact(|tx| {
                    tx.call(&addr(member)).run(move || {
                        ERC20Client::new(&ADDRESS_NATIVE_TOKEN)
                            .adjust_allowance(&credit, NATIVE / 2)
                    })
                })
                .assert_success();
            }
            env.advance_block();
        }

        Self {
            env,
            _code: code,
            credit,
        }
    }

    // Run `f` against the network as `caller`, in the current block, and require it to commit.
    fn call<R>(&self, caller: &str, f: impl FnOnce(MutualCreditClient) -> R) -> R
    where
        R: WriteXDR + xdr::ReadXDROwned,
    {
        let credit = self.credit;
        let result = self.env.transact(|tx| {
            tx.call(&addr(caller))
                .run(AssertUnwindSafe(|| f(MutualCreditClient::new(&credit))))
        });
        result.assert_success();
        result.assert_return_as::<R>()
    }

    // The error the call `f` makes fails with, as `caller`. `f` returns the call's error:
    // `|c| c.try_pay(to, routes).err()`.
    fn refused(
        &self,
        caller: &str,
        f: impl FnOnce(MutualCreditClient) -> Option<CallError>,
    ) -> CreditError {
        let credit = self.credit;
        let mut error = None;
        self.env
            .transact(|tx| {
                tx.call(&addr(caller)).run(AssertUnwindSafe(|| {
                    error = f(MutualCreditClient::new(&credit));
                }))
            })
            .assert_success();
        error
            .expect("the call succeeded")
            .try_as::<CreditError>()
            .expect("a credit error")
    }

    // Execute `f` as `caller` in the current block, without committing it.
    fn pending(
        &self,
        caller: &str,
        f: impl FnOnce(MutualCreditClient) + 'static,
    ) -> MockTransactionHandler {
        let credit = self.credit;
        let mut tx = self.env.transaction().build();
        tx.call(&addr(caller))
            .run(AssertUnwindSafe(move || {
                f(MutualCreditClient::new(&credit))
            }))
            .assert_success();
        tx
    }

    // Let `debtor` owe `creditor` up to `limit`.
    fn trust(&self, creditor: &str, debtor: &str, limit: i128) {
        let debtor = addr(debtor);
        self.call(creditor, |c| c.set_limit(debtor, limit));
    }

    // Pay `amount` from `from` to `to` along one route, through `via`.
    fn pay(&self, from: &str, to: &str, via: &[&str], amount: i128) -> i128 {
        let (to, routes) = (addr(to), routes(vec![route(via, amount)]));
        self.call(from, |c| c.pay(to, routes))
    }

    // The same payment, executed in the current block but not committed.
    fn pending_pay(
        &self,
        from: &str,
        to: &str,
        via: &[&str],
        amount: i128,
    ) -> MockTransactionHandler {
        let (to, routes) = (addr(to), routes(vec![route(via, amount)]));
        self.pending(from, move |c| {
            c.pay(to, routes);
        })
    }

    // The line `creditor` extends to `debtor`, as of this block's start.
    fn line(&self, creditor: &str, debtor: &str) -> Line {
        let (creditor, debtor) = (addr(creditor), addr(debtor));
        self.call("viewer", |c| c.line(creditor, debtor))
    }

    // Each member's position among `members`: what the others owe it, less what it owes them.
    fn positions(&self, members: &[&str]) -> Vec<i128> {
        members
            .iter()
            .map(|member| {
                members
                    .iter()
                    .filter(|other| *other != member)
                    .map(|other| self.line(member, other).owed)
                    .sum()
            })
            .collect()
    }

    fn native(&self, holder: ContractAddress) -> i128 {
        let r = self.env.transact(|tx| {
            tx.call(&addr("viewer"))
                .run(move || ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&holder))
        });
        r.assert_success();
        r.assert_return_as::<i128>()
    }
}

fn line(limit: i128, owed: i128) -> Line {
    Line {
        limit,
        owed,
        room: limit - owed,
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

// What storing a pair costs at most, as the network prices storage by default.
fn pair_cost() -> i128 {
    let costs = TestEnvironment::default().get_current_cost_model().as_xdr();
    pair_storage_cost(
        costs.base_data_item_cost.into(),
        costs.bytestring_cost_per_byte.into(),
    )
}

// Bob trusts Alice, and Carol trusts Bob, so Alice can pay Carol through Bob. Bob ends up owed by
// Alice what he owes Carol: his position does not move. And Carol can pay Alice back the same way
// without anyone trusting her, because each hop pays down a debt.
#[test]
fn a_payment_ripples_through_a_friend() {
    let n = Network::new();
    let members = ["alice", "bob", "carol"];
    n.trust("bob", "alice", 100);
    n.trust("carol", "bob", 100);
    n.env.advance_block();

    assert_eq!(n.pay("alice", "carol", &["bob"], 30), 30);
    n.env.advance_block();
    assert_eq!(n.line("bob", "alice"), line(100, 30));
    assert_eq!(n.line("carol", "bob"), line(100, 30));
    assert_eq!(n.positions(&members), [-30, 0, 30]);

    // Alice extends Bob no credit, but Bob may still pay her what she owes him.
    assert_eq!(n.line("alice", "bob"), line(0, -30));

    assert_eq!(n.pay("carol", "alice", &["bob"], 20), 20);
    n.env.advance_block();
    assert_eq!(n.line("bob", "alice"), line(100, 10));
    assert_eq!(n.line("carol", "bob"), line(100, 10));
    assert_eq!(n.positions(&members), [-10, 0, 10]);

    // Past what is owed, paying Alice would need Bob to trust Carol.
    let to_alice = addr("alice");
    assert_eq!(
        n.refused("carol", |c| c
            .try_pay(to_alice, routes(vec![route(&["bob"], 11)]))
            .err()),
        CreditError::NotEnoughCredit
    );
}

// A hundred members, each trusted by a hub, and a shop that trusts the hub.
fn hub_and_shop(members: &[String], member_limit: i128, shop_limit: i128) -> Network {
    let n = Network::new();
    for member in members {
        n.trust("hub", member, member_limit);
    }
    n.trust("shop", "hub", shop_limit);
    n.env.advance_block();
    n
}

// Every member buys from the shop through the hub, all in one block: the hub's line from the shop
// carries every payment, and none of them waits for another.
#[test]
fn a_hundred_payments_through_one_member_land_in_one_block() {
    let members = names("member", 100);
    let n = hub_and_shop(&members, 50, 10_000);
    for member in &members {
        n.pay(member, "shop", &["hub"], 10);
    }
    n.env.advance_block();

    assert_eq!(n.line("shop", "hub"), line(10_000, 1_000));
    for member in &members {
        assert_eq!(n.line("hub", member), line(50, 10));
    }
    // The hub is owed by the members exactly what it owes the shop.
    let owed_to_hub: i128 = members.iter().map(|m| n.line("hub", m).owed).sum();
    assert_eq!(owed_to_hub, n.line("shop", "hub").owed);
}

// In one block, half the members buy more from the shop, and the shop refunds the other half.
// Committed in either order, the network ends up the same: each payment only adds to and takes from
// rooms, and those deltas add up whatever their order.
fn mixed_block(order: impl Iterator<Item = usize>) -> Network {
    let members = names("member", 20);
    let n = hub_and_shop(&members, 50, 10_000);
    for member in &members {
        n.pay(member, "shop", &["hub"], 20);
    }
    n.env.advance_block();

    let txs: Vec<_> = members
        .iter()
        .enumerate()
        .map(|(i, member)| {
            if i % 2 == 0 {
                n.pending_pay(member, "shop", &["hub"], 5)
            } else {
                n.pending_pay("shop", member, &["hub"], 15)
            }
        })
        .collect();
    let mut txs: Vec<_> = txs.into_iter().map(Some).collect();
    let ordered: Vec<_> = order.map(|i| txs[i].take().unwrap()).collect();
    let results = commit_all(ordered);
    assert_eq!(admitted(&results), members.len());
    n.env.advance_block();
    n
}

#[test]
fn payments_in_a_block_commute() {
    let forward = mixed_block(0..20);
    let backward = mixed_block((0..20).rev());

    let members = names("member", 20);
    for (i, member) in members.iter().enumerate() {
        let expected = if i % 2 == 0 {
            line(50, 25)
        } else {
            line(50, 5)
        };
        assert_eq!(forward.line("hub", member), expected);
        assert_eq!(backward.line("hub", member), expected);
    }
    // Ten members paid 5 more, and ten were refunded 15: 400 + 50 - 150.
    assert_eq!(forward.line("shop", "hub"), line(10_000, 300));
    assert_eq!(backward.line("shop", "hub"), line(10_000, 300));
}

// The shop trusts the hub with only 50, and ten members try to pay 10 each through it in one block.
// Each payment passes the contract's own check, which sees the room as of the block's start; the
// runtime admits them while they fit together, and turns away the rest.
#[test]
fn the_runtime_keeps_every_line_within_its_limit() {
    let members = names("member", 10);
    let n = hub_and_shop(&members, 50, 50);

    let txs: Vec<_> = members
        .iter()
        .map(|member| n.pending_pay(member, "shop", &["hub"], 10))
        .collect();
    let results = commit_all(txs);
    assert_eq!(admitted(&results), 5);
    for refused in results.iter().filter(|r| **r != TryCommitResult::Ok) {
        assert_eq!(conflicts(refused), vec![DbConflictCode::BoundsExceeded]);
    }
    n.env.advance_block();

    assert_eq!(n.line("shop", "hub"), line(50, 50));
    let owed: Vec<_> = members.iter().map(|m| n.line("hub", m).owed).collect();
    assert_eq!(owed, [10, 10, 10, 10, 10, 0, 0, 0, 0, 0]);

    // A payment that could never fit is refused by the contract, with a clear error.
    let shop = addr("shop");
    assert_eq!(
        n.refused("member-9", |c| c
            .try_pay(shop, routes(vec![route(&["hub"], 1)]))
            .err()),
        CreditError::NotEnoughCredit
    );
}

// A creditor cutting a line and a debtor drawing on it, in one block, which together take more than
// the line has. Each passes its own check, and whichever commits second is turned away.
#[test]
fn a_cut_and_a_payment_cannot_overdraw_one_block() {
    for pay_first in [true, false] {
        let n = Network::new();
        n.trust("bob", "alice", 100);
        n.env.advance_block();

        let pay = n.pending_pay("alice", "bob", &[], 60);
        let alice = addr("alice");
        let cut = n.pending("bob", move |c| c.set_limit(alice, 30));
        let results = if pay_first {
            commit_all(vec![pay, cut])
        } else {
            commit_all(vec![cut, pay])
        };
        assert_eq!(results[0], TryCommitResult::Ok);
        assert_eq!(conflicts(&results[1]), vec![DbConflictCode::BoundsExceeded]);
        n.env.advance_block();

        let expected = if pay_first {
            line(100, 60)
        } else {
            line(30, 0)
        };
        assert_eq!(n.line("bob", "alice"), expected);
    }
}

// A limit can be cut to what is owed, which stops any more borrowing, but not below it. A raise
// counts from the next block.
#[test]
fn a_limit_cannot_be_cut_below_the_debt() {
    let n = Network::new();
    let (alice, bob) = (addr("alice"), addr("bob"));
    n.trust("bob", "alice", 100);
    n.env.advance_block();
    n.pay("alice", "bob", &[], 60);
    n.env.advance_block();

    assert_eq!(
        n.refused("bob", |c| c.try_set_limit(alice, 59).err()),
        CreditError::LimitBelowDebt
    );
    n.trust("bob", "alice", 60);
    n.env.advance_block();
    assert_eq!(n.line("bob", "alice"), line(60, 60));
    let one = || routes(vec![route(&[], 1)]);
    assert_eq!(
        n.refused("alice", |c| c.try_pay(bob, one()).err()),
        CreditError::NotEnoughCredit
    );

    // Raised: not in this block, but from the next.
    n.trust("bob", "alice", 80);
    assert_eq!(
        n.refused("alice", |c| c.try_pay(bob, one()).err()),
        CreditError::NotEnoughCredit
    );
    n.env.advance_block();
    n.pay("alice", "bob", &[], 20);
    n.env.advance_block();
    assert_eq!(n.line("bob", "alice"), line(80, 80));
}

// Alice owes Bob, Bob owes Carol, and Carol owes Alice, 10 each. Nobody is up or down, yet every
// line is used up. A payment from Alice to herself, round the cycle the other way, pays down each
// debt -- and so needs no credit at all, even with every limit cut to what is owed.
#[test]
fn a_cycle_of_debts_clears_with_a_payment_to_yourself() {
    let n = Network::new();
    let members = ["alice", "bob", "carol"];
    n.trust("bob", "alice", 10);
    n.trust("carol", "bob", 10);
    n.trust("alice", "carol", 10);
    n.env.advance_block();
    n.pay("alice", "bob", &[], 10);
    n.pay("bob", "carol", &[], 10);
    n.pay("carol", "alice", &[], 10);
    n.env.advance_block();

    assert_eq!(n.positions(&members), [0, 0, 0]);
    assert_eq!(n.line("bob", "alice"), line(10, 10));
    assert_eq!(n.line("carol", "bob"), line(10, 10));
    assert_eq!(n.line("alice", "carol"), line(10, 10));

    // Round the cycle the way the debts run, a payment to herself would need credit nobody has.
    let alice = addr("alice");
    assert_eq!(
        n.refused("alice", |c| c
            .try_pay(alice, routes(vec![route(&["bob", "carol"], 10)]))
            .err()),
        CreditError::NotEnoughCredit
    );

    // The other way, it cancels the debts.
    assert_eq!(n.pay("alice", "alice", &["carol", "bob"], 10), 10);
    n.env.advance_block();
    assert_eq!(n.positions(&members), [0, 0, 0]);
    assert_eq!(n.line("bob", "alice"), line(10, 0));
    assert_eq!(n.line("carol", "bob"), line(10, 0));
    assert_eq!(n.line("alice", "carol"), line(10, 0));
}

// Alice pays Dave 80, which neither of her routes to him could carry alone. A payment is all or
// nothing: when one of its routes lacks room, none of it moves.
#[test]
fn a_payment_splits_over_routes_or_not_at_all() {
    let n = Network::new();
    for via in ["bob", "carol"] {
        n.trust(via, "alice", 50);
        n.trust("dave", via, 50);
    }
    n.env.advance_block();

    let dave = addr("dave");
    let split = routes(vec![route(&["bob"], 40), route(&["carol"], 40)]);
    assert_eq!(n.call("alice", |c| c.pay(dave, split)), 80);
    n.env.advance_block();
    for via in ["bob", "carol"] {
        assert_eq!(n.line(via, "alice"), line(50, 40));
        assert_eq!(n.line("dave", via), line(50, 40));
    }

    let too_much = routes(vec![route(&["bob"], 10), route(&["carol"], 11)]);
    assert_eq!(
        n.refused("alice", |c| c.try_pay(dave, too_much).err()),
        CreditError::NotEnoughCredit
    );
    n.env.advance_block();
    assert_eq!(n.line("bob", "alice"), line(50, 40));
}

// Alice and Bob each extend the other credit for the first time, in one block. Both find no pair,
// and both would open it, but only one can: the other is left out, and takes no bond. Sent again,
// it is a limit on the pair that is now open. Two limit changes on one pair in one block conflict
// the same way.
#[test]
fn a_pair_opens_once() {
    let bond = 1_000;
    let n = Network::start(Storage::Free, bond, 2 * bond, &["alice", "bob"]);
    let (alice, bob) = (addr("alice"), addr("bob"));

    let results = commit_all(vec![
        n.pending("bob", move |c| c.set_limit(alice, 100)),
        n.pending("alice", move |c| c.set_limit(bob, 50)),
    ]);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert!(conflicts(&results[1]).contains(&DbConflictCode::ExclusiveLockDenied));
    n.env.advance_block();
    assert_eq!(n.native(bob), NATIVE - bond);
    assert_eq!(n.native(alice), NATIVE);

    n.trust("alice", "bob", 50);
    n.env.advance_block();
    assert_eq!(n.native(alice), NATIVE);
    assert_eq!(n.line("bob", "alice"), line(100, 0));
    assert_eq!(n.line("alice", "bob"), line(50, 0));

    let results = commit_all(vec![
        n.pending("bob", move |c| c.set_limit(alice, 90)),
        n.pending("alice", move |c| c.set_limit(bob, 40)),
    ]);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert_eq!(
        conflicts(&results[1]),
        vec![DbConflictCode::ExclusiveLockDenied]
    );
}

// Bob sends the same raise twice in one block. Both compute the change from the limit as of the
// block's start, and would each give it to the room, but the terms are written with an exclusive
// lock, so only one commits. Without the lock the two identical writes would not conflict: the
// limit would rise once, and the room twice.
#[test]
fn the_same_raise_twice_in_a_block_lands_once() {
    let n = Network::new();
    let alice = addr("alice");
    n.trust("bob", "alice", 100);
    n.env.advance_block();

    let results = commit_all(vec![
        n.pending("bob", move |c| c.set_limit(alice, 150)),
        n.pending("bob", move |c| c.set_limit(alice, 150)),
    ]);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert_eq!(
        conflicts(&results[1]),
        vec![DbConflictCode::ExclusiveLockDenied]
    );
    n.env.advance_block();
    assert_eq!(n.line("bob", "alice"), line(150, 0));
}

// A pair can be closed once neither member extends credit to the other, which leaves nothing owed.
// The bond goes back to whoever opened it, once: two closes in one block cannot both commit.
#[test]
fn a_pair_closes_once_and_returns_its_bond() {
    let bond = 1_000;
    let n = Network::start(Storage::Free, bond, 2 * bond, &["alice", "bob"]);
    let (alice, bob) = (addr("alice"), addr("bob"));
    n.trust("bob", "alice", 100);
    n.env.advance_block();
    n.pay("alice", "bob", &[], 30);
    n.env.advance_block();

    assert_eq!(
        n.refused("alice", |c| c.try_close(bob).err()),
        CreditError::CreditExtended
    );
    assert_eq!(
        n.refused("bob", |c| c.try_set_limit(alice, 0).err()),
        CreditError::LimitBelowDebt
    );

    // Bob buys from Alice, which pays her debt down, and then cuts her off.
    n.pay("bob", "alice", &[], 30);
    n.env.advance_block();
    n.trust("bob", "alice", 0);
    n.env.advance_block();
    assert_eq!(n.line("bob", "alice"), line(0, 0));

    let results = commit_all(vec![
        n.pending("alice", move |c| c.close(bob)),
        n.pending("bob", move |c| c.close(alice)),
    ]);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert!(conflicts(&results[1]).contains(&DbConflictCode::ExclusiveLockDenied));
    n.env.advance_block();
    assert_eq!(n.native(bob), NATIVE);
    assert_eq!(n.native(n.credit), 2 * bond);
    assert_eq!(n.line("bob", "alice"), Line::default());
    assert_eq!(
        n.refused("bob", |c| c.try_close(alice).err()),
        CreditError::NoSuchPair
    );

    // Opening the pair again takes a new bond, from whoever opens it.
    n.trust("alice", "bob", 10);
    n.env.advance_block();
    assert_eq!(n.native(alice), NATIVE - bond);
}

// A call that should be refused: who makes it, the call, and the error it should fail with.
type Refusal = (
    &'static str,
    fn(MutualCreditClient) -> Option<CallError>,
    CreditError,
);

fn pay_to(to: &str, list: Vec<Route>) -> impl FnOnce(MutualCreditClient) -> Option<CallError> {
    let to = addr(to);
    move |c| c.try_pay(to, routes(list)).err()
}

// Each refusal is checked against a network where Bob trusts Alice and Carol trusts Bob, so every
// route below would otherwise have room.
#[test]
fn bad_limits_and_routes_are_refused() {
    let n = Network::new();
    n.trust("bob", "alice", 100);
    n.trust("carol", "bob", 100);
    n.env.advance_block();

    let refusals: [Refusal; 7] = [
        (
            "alice",
            |c| c.try_set_limit(addr("alice"), 10).err(),
            CreditError::SelfCredit,
        ),
        (
            "alice",
            |c| c.try_set_limit(addr("bob"), -1).err(),
            CreditError::InvalidLimit,
        ),
        (
            "alice",
            |c| c.try_set_limit(addr("bob"), MAX_LIMIT + 1).err(),
            CreditError::InvalidLimit,
        ),
        // Nothing to open.
        (
            "alice",
            |c| c.try_set_limit(addr("dave"), 0).err(),
            CreditError::InvalidLimit,
        ),
        (
            "viewer",
            |c| c.try_line(addr("alice"), addr("alice")).err(),
            CreditError::SelfCredit,
        ),
        (
            "alice",
            |c| c.try_close(addr("carol")).err(),
            CreditError::NoSuchPair,
        ),
        // No line from Carol to Alice.
        (
            "alice",
            |c| c.try_pay(addr("carol"), routes(vec![route(&[], 1)])).err(),
            CreditError::NotEnoughCredit,
        ),
    ];
    for (caller, call, error) in refusals {
        assert_eq!(n.refused(caller, call), error);
    }

    let bad_routes = [
        // No routes at all, or nothing to send.
        pay_to("carol", vec![]),
        pay_to("carol", vec![route(&["bob"], 0)]),
        pay_to("carol", vec![route(&["bob"], 10), route(&["bob"], -1)]),
        // Someone twice: the payer, the payee, or a member in between.
        pay_to("carol", vec![route(&["bob", "bob"], 10)]),
        pay_to("carol", vec![route(&["alice", "bob"], 10)]),
        pay_to("carol", vec![route(&["bob", "carol"], 10)]),
        // A payment to oneself goes round at least two others.
        pay_to("alice", vec![route(&[], 10)]),
        pay_to("alice", vec![route(&["bob"], 10)]),
    ];
    for call in bad_routes {
        assert_eq!(n.refused("alice", call), CreditError::InvalidRoute);
    }

    // The checks refused everything: nothing is owed.
    assert_eq!(n.line("bob", "alice"), line(100, 0));
}

// The largest payment there is: four routes of six members each, so twenty-eight hops. It fits in
// one transaction, and so does its event, which carries every route.
#[test]
fn the_largest_payment_fits() {
    let n = Network::new();
    let via: Vec<Vec<String>> = (0..MAX_ROUTES)
        .map(|r| names(&format!("route-{r}"), MAX_VIA as usize))
        .collect();
    for members in &via {
        let mut debtor = "payer";
        for creditor in members.iter().map(String::as_str).chain(["payee"]) {
            n.trust(creditor, debtor, 1_000);
            debtor = creditor;
        }
    }
    n.env.advance_block();

    let list: Vec<_> = via
        .iter()
        .map(|members| {
            let members: Vec<&str> = members.iter().map(String::as_str).collect();
            route(&members, 100)
        })
        .collect();
    let payee = addr("payee");
    assert_eq!(n.call("payer", |c| c.pay(payee, routes(list))), 400);
    n.env.advance_block();
    for members in &via {
        assert_eq!(n.line(&members[0], "payer"), line(1_000, 100));
        assert_eq!(n.line("payee", &members[5]), line(1_000, 100));
    }
}

#[test]
fn the_network_starts_once() {
    let env = TestEnvironment::no_cost();
    let code = register_mock_contract(&env);
    let hash = *code.as_hash();
    let founder = addr("founder");
    env.setup_grant_storage_tokens(&founder, NATIVE as i64);

    let deployed = env.transact(|tx| {
        tx.call(&founder)
            .run(move || deploy_contract(&sha256_static!("credit"), &hash))
    });
    deployed.assert_success();
    let credit = deployed.assert_return_as::<ContractAddress>();
    env.advance_block();

    let refused = |call: fn(MutualCreditClient) -> Option<CallError>| {
        let mut error = None;
        env.transact(|tx| {
            tx.call(&founder).run(AssertUnwindSafe(|| {
                error = call(MutualCreditClient::new(&credit));
            }))
        })
        .assert_success();
        error.unwrap().try_as::<CreditError>().unwrap()
    };
    assert_eq!(
        refused(|c| c.try_set_limit(addr("bob"), 10).err()),
        CreditError::NotInitialized
    );
    assert_eq!(
        refused(|c| c.try_initialize(-1).err()),
        CreditError::InvalidBond
    );
    // A bond of 1,000 asks for a reserve of 2,000, and the network holds nothing.
    assert_eq!(
        refused(|c| c.try_initialize(1_000).err()),
        CreditError::ReserveTooSmall
    );

    env.transact(|tx| {
        tx.call(&founder)
            .run(move || MutualCreditClient::new(&credit).initialize(0))
    })
    .assert_success();
    env.advance_block();
    assert_eq!(
        refused(|c| c.try_initialize(0).err()),
        CreditError::AlreadyInitialized
    );
}

// With storage priced as the network prices it, and a bond of what a pair costs at most to store,
// opening pairs costs the network nothing, and payments cost it nothing at all: they only write
// rooms that already exist. Closing every pair in one block refunds every bond, and leaves the
// network holding what it started with.
#[test]
fn bonded_pairs_pay_for_their_own_storage() {
    let bond = pair_cost();
    let members = names("member", 20);
    let everyone: Vec<&str> = members.iter().map(String::as_str).chain(["hub"]).collect();
    let n = Network::start(Storage::Priced, bond, reserve_needed(bond), &everyone);
    let start = n.native(n.credit);

    // The hub opens a pair with every member, all in one block, and in the next each member trusts
    // the hub back, on the pair that is now open: that takes no bond. Then the hub trusts one
    // member with as much as it can, which makes that pair's terms as large as they get.
    for member in &members {
        n.trust("hub", member, 100);
    }
    n.env.advance_block();
    for member in &members {
        n.trust(member, "hub", 100);
    }
    n.env.advance_block();
    n.trust("hub", "member-0", MAX_LIMIT);
    n.env.advance_block();
    // Each bond covers its pair, with room to spare while limits are small.
    let open = n.native(n.credit);
    assert!(open >= start);
    assert_eq!(n.native(addr("hub")), NATIVE - 20 * bond);
    assert_eq!(n.native(addr("member-0")), NATIVE);

    // Members pay each other through the hub, in both directions, and the network's tokens do not
    // move: no payment creates storage.
    for pair in members.chunks(2) {
        n.pay(&pair[0], &pair[1], &["hub"], 10);
    }
    n.env.advance_block();
    for pair in members.chunks(2) {
        n.pay(&pair[1], &pair[0], &["hub"], 10);
    }
    n.env.advance_block();
    assert_eq!(n.native(n.credit), open);

    // Everything is paid back, so every line can be cut, and every pair closed. Together the
    // closes refund far more than the network holds, but each gets back the deposits of the pair
    // it deletes when it commits.
    assert!(open < 20 * bond);
    for member in &members {
        n.trust("hub", member, 0);
    }
    n.env.advance_block();
    for member in &members {
        n.trust(member, "hub", 0);
    }
    n.env.advance_block();
    for member in &members {
        let member = addr(member);
        n.call("hub", |c| c.close(member));
    }
    n.env.advance_block();
    assert_eq!(n.native(n.credit), start);
    assert_eq!(n.native(addr("hub")), NATIVE);
}

// Without the bond, every pair is a deposit out of the network's own native tokens. A member who
// opens enough of them spends what the network holds, and from then on nobody can open a pair.
#[test]
fn without_a_bond_pairs_drain_the_reserve() {
    let n = Network::start(Storage::Priced, 0, 5 * pair_cost(), &["hub"]);

    let members = names("member", 20);
    let results: Vec<_> = members
        .iter()
        .map(|member| {
            let member = addr(member);
            let mut tx = n.pending("hub", move |c| c.set_limit(member, 100));
            tx.try_commit_transaction()
        })
        .collect();
    let refused: Vec<_> = results
        .into_iter()
        .filter(|r| *r != TryCommitResult::Ok)
        .collect();
    assert!(!refused.is_empty(), "the reserve covered every pair");
    for result in refused {
        assert_eq!(conflicts(&result), vec![DbConflictCode::InsufficientFunds]);
    }
}
