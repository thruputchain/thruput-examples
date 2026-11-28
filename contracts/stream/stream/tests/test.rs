use erc20::{ERC20Client, ERC20MetadataClient};
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use stream::*;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

// Blocks are a second apart from START, unless a test jumps ahead.
const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000;

// What each payer starts with, all of which the contract may take.
const FUNDS: i128 = 1_000_000_000;

// The native tokens each party starts with when storage is priced: plenty for bonds, and for the
// token's own storage.
const NATIVE: i128 = 100_000_000;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn names(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}-{i}")).collect()
}

// Whether storage is free, as in most of these tests, or priced as the network prices it, with a
// bond for each item a stream creates.
#[derive(Clone, Copy)]
enum Storage {
    Free,
    Priced { item_bond: i128 },
}

struct Fixture {
    env: TestEnvironmentHandle,
    _codes: [MockContract; 2],
    stream: ContractAddress,
    token: ContractAddress,
}

impl Fixture {
    // A stream contract on a fresh token, with `payers` funded and their allowances granted.
    // Returns in a block at START plus two seconds.
    fn new(payers: &[String]) -> Self {
        Self::with_storage(payers, Storage::Free, 0)
    }

    // The same, with storage free or priced, and the contract holding `reserve` native tokens
    // beyond what `reserve_needed` asks for.
    fn with_storage(payers: &[String], storage: Storage, reserve: i128) -> Self {
        let (env, item_bond) = match storage {
            Storage::Free => (TestEnvironment::no_cost(), 0),
            Storage::Priced { item_bond } => (TestEnvironment::default(), item_bond),
        };
        let deployer = addr("deployer");
        let payer_addrs: Vec<_> = payers.iter().map(|p| addr(p)).collect();
        if let Storage::Priced { .. } = storage {
            // The native token pays for its own allowance rows, like any token.
            for who in payer_addrs.iter().chain([&deployer, &ADDRESS_NATIVE_TOKEN]) {
                env.setup_grant_storage_tokens(who, NATIVE as i64);
            }
        }
        env.advance_block_at((START * SECOND).into());
        env.set_block_time_step(Some(Duration::from_secs(1)));

        let code = register_mock_contract(&env);
        let token_code = erc20::register_mock_contract(&env);
        let native = ERC20Client::new(&ADDRESS_NATIVE_TOKEN);
        let token_reserve = match storage {
            Storage::Free => 0,
            Storage::Priced { .. } => NATIVE / 10,
        };
        let stream_reserve = reserve_needed(item_bond) + reserve;

        let (mut stream, mut token) = (deployer, deployer);
        env.transact(|tx| {
            tx.call(&deployer).run(AssertUnwindSafe(|| {
                token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
                if token_reserve > 0 {
                    native.transfer(&token, token_reserve);
                }
                ERC20MetadataClient::new(&token).initialize(&deployer, None, None, Some(2));
                for payer in &payer_addrs {
                    ERC20Client::new(&token).mint(payer, FUNDS);
                }

                // Deploy and start the contract in one transaction, so nobody can start it first.
                stream = deploy_contract(&sha256_static!("stream"), code.as_hash());
                if stream_reserve > 0 {
                    native.transfer(&stream, stream_reserve);
                }
                StreamClient::new(&stream).initialize(Terms { token, item_bond });
            }))
        })
        .assert_success();
        // The tokens are visible to other transactions from the next block.
        env.advance_block();

        for payer in payer_addrs {
            env.transact(|tx| {
                tx.call(&payer).run(move || {
                    ERC20Client::new(&token).adjust_allowance(&stream, FUNDS);
                    if item_bond > 0 {
                        ERC20Client::new(&ADDRESS_NATIVE_TOKEN)
                            .adjust_allowance(&stream, NATIVE / 2);
                    }
                })
            })
            .assert_success();
        }
        env.advance_block();

        Self {
            env,
            _codes: [code, token_code],
            stream,
            token,
        }
    }

    // Run `f` against the contract as `caller`, in the current block, and require it to succeed.
    fn call<R>(&self, caller: &str, f: impl FnOnce(StreamClient) -> R) -> R
    where
        R: WriteXDR + xdr::ReadXDROwned,
    {
        let stream = self.stream;
        let result = self.env.transact(|tx| {
            tx.call(&addr(caller))
                .run(AssertUnwindSafe(|| f(StreamClient::new(&stream))))
        });
        result.assert_success();
        result.assert_return_as::<R>()
    }

    // Run `f` as `caller` in the current block without committing it, and require it to succeed.
    // Returns the transaction, to commit, and what `f` returned.
    fn pending<R>(
        &self,
        caller: &str,
        f: impl FnOnce(StreamClient) -> R,
    ) -> (MockTransactionHandler, R)
    where
        R: WriteXDR + xdr::ReadXDROwned,
    {
        let stream = self.stream;
        let mut tx = self.env.transaction().build();
        let result = tx
            .call(&addr(caller))
            .run(AssertUnwindSafe(|| f(StreamClient::new(&stream))));
        result.assert_success();
        let value = result.assert_return_as::<R>();
        (tx, value)
    }

    // The stream error the call `f` fails with, as `caller`. `f` returns the call's error:
    // `|c| c.try_withdraw().err()`.
    fn refused(
        &self,
        caller: &str,
        f: impl FnOnce(StreamClient) -> Option<CallError>,
    ) -> StreamError {
        let stream = self.stream;
        let mut error = None;
        self.env
            .transact(|tx| {
                tx.call(&addr(caller)).run(AssertUnwindSafe(|| {
                    error = f(StreamClient::new(&stream));
                }))
            })
            .assert_success();
        error
            .expect("the call succeeded")
            .try_as::<StreamError>()
            .expect("a stream error")
    }

    fn open(&self, payer: &str, payee: &str, id: u64, rate: u64, seconds: u64) -> Flow {
        let payee = addr(payee);
        self.call(payer, |c| c.open(&payee, id, rate, seconds))
    }

    fn cancel(&self, payer: &str, id: u64) -> Cancellation {
        self.call(payer, |c| c.cancel(id))
    }

    fn withdraw(&self, payee: &str) -> i128 {
        self.call(payee, |c| c.withdraw())
    }

    fn owed(&self, payee: &str) -> i128 {
        let payee = addr(payee);
        self.call("viewer", |c| c.owed(&payee))
    }

    fn owed_at(&self, payee: &str, time: u64) -> i128 {
        let payee = addr(payee);
        self.call("viewer", |c| c.owed_at(&payee, time))
    }

    fn rate(&self, payee: &str) -> i128 {
        let payee = addr(payee);
        self.call("viewer", |c| c.rate(&payee))
    }

    // The current block's time, in Unix seconds.
    fn now(&self) -> u64 {
        let r = self.env.transact(|tx| {
            tx.call(&addr("viewer"))
                .run(|| get_block_timepoint().into_inner() / SECOND)
        });
        r.assert_success();
        r.assert_return_as::<u64>()
    }

    // Move to a block at `time`, in Unix seconds.
    fn at(&self, time: u64) {
        self.env.advance_block_at((time * SECOND).into());
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

    // What the contract itself holds of the token.
    fn held(&self) -> i128 {
        self.balance_in(self.token, self.stream)
    }

    fn native(&self, holder: ContractAddress) -> i128 {
        self.balance_in(ADDRESS_NATIVE_TOKEN, holder)
    }
}

// Commit `txs` in order, and return how each fared.
fn commit_all(mut txs: Vec<MockTransactionHandler>) -> Vec<TryCommitResult> {
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

// What every stream would pay, worked out one stream at a time: the slow way the contract's sums
// must agree with.
#[derive(Default)]
struct Model {
    flows: Vec<ModelFlow>,
}

struct ModelFlow {
    payer: String,
    payee: String,
    id: u64,
    rate: i128,
    start: u64,
    end: u64,
    open: bool,
}

impl Model {
    fn open(&mut self, payer: &str, payee: &str, id: u64, flow: Flow) {
        self.flows.push(ModelFlow {
            payer: payer.to_string(),
            payee: payee.to_string(),
            id,
            rate: i128::from(flow.rate),
            start: flow.start,
            end: flow.end,
            open: true,
        });
    }

    // Stop the stream at `now`, and return what it paid, and what it refunds.
    fn cancel(&mut self, payer: &str, id: u64, now: u64) -> Cancellation {
        let flow = self
            .flows
            .iter_mut()
            .find(|f| f.open && f.payer == payer && f.id == id)
            .expect("an open stream");
        flow.open = false;
        if now >= flow.end {
            return Cancellation::default();
        }
        let refund = flow.rate * i128::from(flow.end - now);
        flow.end = now;
        Cancellation {
            paid: flow.rate * i128::from(now - flow.start),
            refund,
        }
    }

    // What `payee` has earned by `time`.
    fn earned(&self, payee: &str, time: u64) -> i128 {
        self.flows
            .iter()
            .filter(|f| f.payee == payee)
            .map(|f| f.rate * i128::from(time.clamp(f.start, f.end) - f.start))
            .sum()
    }

    // What `payer` has paid in, net of refunds.
    fn spent(&self, payer: &str) -> i128 {
        self.flows
            .iter()
            .filter(|f| f.payer == payer)
            .map(|f| f.rate * i128::from(f.end - f.start))
            .sum()
    }
}

// A stream pays its rate every second, from the block it opens in until its end. The payee can
// withdraw whatever has streamed at any time, and once the stream ends, the rest.
#[test]
fn a_stream_pays_by_the_second() {
    let f = Fixture::new(&names("alice", 1));
    let t0 = f.now();
    let flow = f.open("alice-0", "bob", 1, 10, 60);
    assert_eq!(
        flow,
        Flow {
            payee: addr("bob"),
            rate: 10,
            start: t0,
            end: t0 + 60,
        }
    );
    f.env.advance_block();
    assert_eq!(
        f.balance("alice-0"),
        FUNDS - 600,
        "the whole stream is paid in"
    );

    f.at(t0 + 20);
    assert_eq!(f.owed("bob"), 200);
    assert_eq!(f.rate("bob"), 10);
    assert_eq!(f.owed_at("bob", t0 + 45), 450, "and more every second");

    assert_eq!(f.withdraw("bob"), 200);
    f.env.advance_block();
    assert_eq!(f.balance("bob"), 200);
    assert_eq!(f.owed("bob"), 10, "a second later");

    // Past the end, the stream has paid all it holds, and pays no more.
    f.at(t0 + 100);
    assert_eq!(f.owed("bob"), 400);
    assert_eq!(f.rate("bob"), 0);
    assert_eq!(f.withdraw("bob"), 400);
    f.env.advance_block();
    assert_eq!(f.balance("bob"), 600);
    assert_eq!(f.held(), 0);
}

// An agent rents a machine by the second: it opens an hour's stream, uses ten minutes, and
// cancels. The machine's owner keeps exactly ten minutes' pay, and the agent gets the rest back.
#[test]
fn cancelling_refunds_what_has_not_streamed() {
    let f = Fixture::new(&names("agent", 1));
    let t0 = f.now();
    f.open("agent-0", "gpu", 7, 5, 3_600);

    f.at(t0 + 600);
    assert_eq!(
        f.cancel("agent-0", 7),
        Cancellation {
            paid: 3_000,
            refund: 15_000,
        }
    );
    f.env.advance_block();
    assert_eq!(f.balance("agent-0"), FUNDS - 3_000);
    assert_eq!(f.rate("gpu"), 0);

    // What the stream paid stays paid, however long the owner waits to collect it.
    f.at(t0 + 86_400);
    assert_eq!(f.owed("gpu"), 3_000);
    assert_eq!(f.withdraw("gpu"), 3_000);
    f.env.advance_block();
    assert_eq!(f.held(), 0);
    assert_eq!(f.call("viewer", |c| c.flow(&addr("agent-0"), 7)), None);
}

// The payee's rate is the sum of its running streams' rates, and each stops counting at its own
// end.
#[test]
fn streams_add_up_and_end_on_their_own() {
    let f = Fixture::new(&names("payer", 3));
    let t0 = f.now();
    f.open("payer-0", "bob", 1, 3, 10);
    f.open("payer-1", "bob", 1, 5, 20);
    f.open("payer-2", "bob", 1, 7, 30);
    f.env.advance_block();

    assert_eq!(f.rate("bob"), 15);
    assert_eq!(f.owed("bob"), 15);
    for (time, rate, owed) in [
        (t0 + 10, 12, 150),
        (t0 + 15, 12, 210),
        (t0 + 20, 7, 270),
        (t0 + 30, 0, 340),
        (t0 + 1_000, 0, 340),
    ] {
        f.at(time);
        assert_eq!(
            (f.rate("bob"), f.owed("bob")),
            (rate, owed),
            "at {}",
            time - t0
        );
    }
}

fn crowd_flow(i: usize) -> (u64, u64) {
    (1 + (i % 7) as u64, 30 + 13 * i as u64)
}

// A hundred payers open streams to one creator, all executed in one block before any commits.
// Returns the fixture, a block later.
fn crowd_in_one_block(backward: bool) -> (Fixture, u64) {
    let payers = names("fan", 100);
    let f = Fixture::new(&payers);
    let t0 = f.now();
    let creator = addr("creator");
    let mut txs: Vec<_> = payers
        .iter()
        .enumerate()
        .map(|(i, payer)| {
            let (rate, seconds) = crowd_flow(i);
            f.pending(payer, |c| c.open(&creator, 1, rate, seconds)).0
        })
        .collect();
    if backward {
        txs.reverse();
    }
    for result in commit_all(txs) {
        assert_eq!(result, TryCommitResult::Ok);
    }
    f.env.advance_block();
    (f, t0)
}

// Opening a stream only adds to the payee's sums, and reads none of them, so a crowd's streams to
// one payee land in one block, together. Committed in the opposite order, they leave the same
// sums: the creator is owed the same at every moment, and that is what each stream pays.
#[test]
fn a_crowd_streams_to_one_payee_in_one_block_in_any_order() {
    let (forward, t0) = crowd_in_one_block(false);
    let (backward, t0_) = crowd_in_one_block(true);
    assert_eq!(t0, t0_);

    let mut model = Model::default();
    for i in 0..100 {
        let (rate, seconds) = crowd_flow(i);
        let flow = Flow {
            payee: addr("creator"),
            rate,
            start: t0,
            end: t0 + seconds,
        };
        model.open(&format!("fan-{i}"), "creator", 1, flow);
    }

    let rate: i128 = (0..100).map(|i| i128::from(crowd_flow(i).0)).sum();
    for f in [&forward, &backward] {
        assert_eq!(f.rate("creator"), rate);
        for later in [1, 30, 31, 500, 1_000, 1_317, 1_318, 5_000] {
            let time = t0 + later;
            assert_eq!(f.owed_at("creator", time), model.earned("creator", time));
        }
    }
}

// In one block: new streams open, earlier ones are cancelled, and the payee withdraws. None of
// them conflicts with another, in either order, and the withdrawal pays exactly what had streamed
// by the block.
#[test]
fn opens_cancels_and_a_withdrawal_share_a_block() {
    let payers = names("payer", 10);
    let mut sums = Vec::new();
    for backward in [false, true] {
        let f = Fixture::new(&payers);
        let t0 = f.now();
        for (i, payer) in payers.iter().take(5).enumerate() {
            f.open(payer, "bob", 1, 1 + i as u64, 100);
        }
        f.at(t0 + 40);

        let bob = addr("bob");
        let mut txs = Vec::new();
        for (i, payer) in payers.iter().enumerate() {
            if i < 5 {
                txs.push(f.pending(payer, |c| c.cancel(1)).0);
            } else {
                txs.push(f.pending(payer, |c| c.open(&bob, 1, i as u64, 100)).0);
            }
        }
        let (withdrawal, paid) = f.pending("bob", |c| c.withdraw());
        assert_eq!(paid, 40 * (1 + 2 + 3 + 4 + 5));
        txs.insert(3, withdrawal);
        if backward {
            txs.reverse();
        }
        for result in commit_all(txs) {
            assert_eq!(result, TryCommitResult::Ok);
        }

        f.at(t0 + 100);
        // Cancelled streams paid for forty seconds, and the new ones for sixty so far.
        assert_eq!(f.owed("bob"), 60 * (5 + 6 + 7 + 8 + 9));
        assert_eq!(f.rate("bob"), 5 + 6 + 7 + 8 + 9);
        sums.push(f.owed_at("bob", t0 + 1_000));
    }
    assert_eq!(sums[0], sums[1]);
    assert_eq!(sums[0], 100 * (5 + 6 + 7 + 8 + 9));
}

// Two withdrawals in one block would read the same total and pay the same amount twice. The
// withdrawal's exclusive lock lets only one of them commit.
#[test]
fn a_payee_withdraws_once_a_block() {
    let f = Fixture::new(&names("alice", 1));
    let t0 = f.now();
    f.open("alice-0", "bob", 1, 10, 60);
    // Another stream's tokens sit in the contract too: only the lock keeps the second
    // withdrawal from taking them.
    f.open("alice-0", "carol", 2, 10, 60);
    f.at(t0 + 30);

    let (first, a) = f.pending("bob", |c| c.withdraw());
    let (second, b) = f.pending("bob", |c| c.withdraw());
    assert_eq!((a, b), (300, 300));
    let results = commit_all(vec![first, second]);
    f.env.advance_block();

    assert_eq!(f.balance("bob"), 300, "Bob is paid once");
    assert_eq!(results[0], TryCommitResult::Ok);
    assert_eq!(
        conflicts(&results[1]),
        vec![DbConflictCode::ExclusiveLockDenied]
    );
    assert_eq!(f.owed("bob"), 10);
}

// Two cancels of one stream in one block both read its record, but only one can delete it. The
// payer is refunded once, and the id is free again from the next block.
#[test]
fn a_stream_is_cancelled_once() {
    let payers = names("payer", 2);
    let f = Fixture::new(&payers);
    let t0 = f.now();
    f.open("payer-0", "bob", 1, 10, 60);
    // An identical stream from someone else: Bob's totals could cover the first stream's being
    // taken out twice. Only the lock stops it.
    f.open("payer-1", "bob", 1, 10, 60);
    f.at(t0 + 30);

    let (first, _) = f.pending("payer-0", |c| c.cancel(1));
    let (second, _) = f.pending("payer-0", |c| c.cancel(1));
    let results = commit_all(vec![first, second]);
    f.env.advance_block();

    assert_eq!(f.balance("payer-0"), FUNDS - 300, "refunded once");
    assert_eq!(f.owed_at("bob", t0 + 60), 300 + 600);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert!(conflicts(&results[1]).contains(&DbConflictCode::ExclusiveLockDenied));
    assert_eq!(
        f.refused("payer-0", |c| c.try_cancel(1).err()),
        StreamError::NoSuchStream
    );
    // The id is free for a new stream.
    f.open("payer-0", "dave", 1, 1, 1);
}

// Two opens under one id in one block cannot both commit: the record takes an exclusive lock.
#[test]
fn an_id_opens_once() {
    let f = Fixture::new(&names("alice", 1));
    let (bob, carol) = (addr("bob"), addr("carol"));
    let (first, _) = f.pending("alice-0", |c| c.open(&bob, 1, 10, 60));
    let (second, _) = f.pending("alice-0", |c| c.open(&carol, 1, 10, 60));
    let results = commit_all(vec![first, second]);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert!(conflicts(&results[1]).contains(&DbConflictCode::ExclusiveLockDenied));
    f.env.advance_block();

    assert_eq!(f.balance("alice-0"), FUNDS - 600);
    assert_eq!(
        f.refused("alice-0", |c| c.try_open(&carol, 1, 10, 60).err()),
        StreamError::IdInUse
    );
}

// A stream that has ended is cleared away by its payer, for its bond: it moves no tokens, and
// the payee keeps all of it.
#[test]
fn an_ended_stream_is_cleared_for_its_bond() {
    let f = Fixture::new(&names("alice", 1));
    let t0 = f.now();
    f.open("alice-0", "bob", 1, 10, 60);
    f.at(t0 + 60);
    assert_eq!(f.cancel("alice-0", 1), Cancellation::default());
    f.env.advance_block();
    assert_eq!(f.owed("bob"), 600);
    assert_eq!(f.balance("alice-0"), FUNDS - 600);
}

// A small deterministic generator, so the tests need no dependency.
struct Lcg(u64);

impl Lcg {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % n
    }
}

// Many blocks of opens, cancels and withdrawals, by several payers to several payees, several to a
// block. After every block, each payee is owed what the streams paid it, worked out one stream at
// a time. Once every stream has ended and every payee has withdrawn, every token has gone where
// it should, and the contract holds none.
#[test]
fn every_token_comes_out() {
    let payers = names("payer", 6);
    let payees = ["bob", "carol", "dave"];
    let f = Fixture::new(&payers);
    let mut model = Model::default();
    let mut withdrawn = [0i128; 3];
    let mut rng = Lcg(42);
    let mut next_id = 0;

    for _ in 0..40 {
        let now = f.now();
        let mut txs = Vec::new();
        let mut cancelled = Vec::new();
        let mut withdrew = [false; 3];
        for _ in 0..rng.below(6) {
            match rng.below(3) {
                0 => {
                    let payer = &payers[rng.below(6) as usize];
                    let payee = payees[rng.below(3) as usize];
                    let (rate, seconds) = (1 + rng.below(20), 1 + rng.below(200));
                    next_id += 1;
                    let id = next_id;
                    let to = addr(payee);
                    let (tx, flow) = f.pending(payer, |c| c.open(&to, id, rate, seconds));
                    model.open(payer, payee, id, flow);
                    txs.push(tx);
                }
                1 => {
                    // A stream opened in an earlier block, not yet cancelled.
                    let open: Vec<_> = model
                        .flows
                        .iter()
                        .filter(|fl| fl.open && fl.start < now)
                        .map(|fl| (fl.payer.clone(), fl.id))
                        .filter(|key| !cancelled.contains(key))
                        .collect();
                    if open.is_empty() {
                        continue;
                    }
                    let (payer, id) = open[rng.below(open.len() as u64) as usize].clone();
                    let (tx, got) = f.pending(&payer, |c| c.cancel(id));
                    cancelled.push((payer, id));
                    txs.push(tx);
                    let (payer, id) = cancelled.last().unwrap();
                    assert_eq!(got, model.cancel(payer, *id, now));
                }
                _ => {
                    let p = rng.below(3) as usize;
                    let owed = model.earned(payees[p], now) - withdrawn[p];
                    if withdrew[p] || owed == 0 {
                        continue;
                    }
                    let (tx, paid) = f.pending(payees[p], |c| c.withdraw());
                    assert_eq!(paid, owed);
                    withdrawn[p] += paid;
                    withdrew[p] = true;
                    txs.push(tx);
                }
            }
        }
        for result in commit_all(txs) {
            assert_eq!(result, TryCommitResult::Ok);
        }

        f.at(now + 1 + rng.below(30));
        let now = f.now();
        for (p, payee) in payees.iter().enumerate() {
            assert_eq!(f.owed(payee), model.earned(payee, now) - withdrawn[p]);
        }
    }

    // Past every end: clear every record, and let every payee take the rest.
    let last = model.flows.iter().map(|fl| fl.end).max().unwrap();
    f.at(last + 1);
    let open: Vec<_> = model
        .flows
        .iter()
        .filter(|fl| fl.open)
        .map(|fl| (fl.payer.clone(), fl.id))
        .collect();
    for (payer, id) in open {
        assert_eq!(f.cancel(&payer, id), Cancellation::default());
    }
    for (p, payee) in payees.iter().enumerate() {
        let owed = model.earned(payee, last) - withdrawn[p];
        if owed > 0 {
            assert_eq!(f.withdraw(payee), owed);
        }
    }
    f.env.advance_block();

    assert_eq!(f.held(), 0);
    for payee in payees {
        assert_eq!(f.balance(payee), model.earned(payee, last));
    }
    for payer in &payers {
        assert_eq!(f.balance(payer), FUNDS - model.spent(payer));
    }
}

// A call that should be refused: who makes it, the call, and the error it should fail with.
type Refusal = (
    &'static str,
    fn(StreamClient) -> Option<CallError>,
    StreamError,
);

// Calls that should be refused, each with the error it fails with.
#[test]
fn bad_calls_are_refused() {
    let f = Fixture::new(&names("alice", 1));
    let t0 = f.now();
    let here = f.stream;
    f.open("alice-0", "bob", 1, 10, 60);
    f.env.advance_block();

    let refusals: [Refusal; 9] = [
        (
            "alice-0",
            |c| c.try_open(&addr("bob"), 2, 0, 60).err(),
            StreamError::ZeroRate,
        ),
        (
            "alice-0",
            |c| c.try_open(&addr("bob"), 2, 10, 0).err(),
            StreamError::ZeroDuration,
        ),
        (
            "alice-0",
            |c| c.try_open(&addr("bob"), 2, 1, u64::from(u32::MAX)).err(),
            StreamError::TooLong,
        ),
        (
            "alice-0",
            |c| c.try_open(&addr("bob"), 2, u64::MAX, u64::MAX).err(),
            StreamError::TooLarge,
        ),
        (
            "alice-0",
            |c| c.try_open(&addr("bob"), 1, 10, 60).err(),
            StreamError::IdInUse,
        ),
        (
            "alice-0",
            |c| c.try_cancel(2).err(),
            StreamError::NoSuchStream,
        ),
        ("bob", |c| c.try_cancel(1).err(), StreamError::NoSuchStream),
        (
            "carol",
            |c| c.try_withdraw().err(),
            StreamError::NothingOwed,
        ),
        (
            "viewer",
            |c| c.try_owed_at(&addr("bob"), 1).err(),
            StreamError::InThePast,
        ),
    ];
    for (caller, call, error) in refusals {
        assert_eq!(f.refused(caller, call), error);
    }
    assert_eq!(
        f.refused("alice-0", |c| c.try_open(&here, 2, 10, 60).err()),
        StreamError::InvalidPayee
    );
    let token = f.token;
    assert_eq!(
        f.refused("alice-0", |c| c
            .try_initialize(Terms {
                token,
                item_bond: 0,
            })
            .err()),
        StreamError::AlreadyInitialized
    );

    // None of that touched Bob's stream.
    f.at(t0 + 60);
    assert_eq!(f.owed("bob"), 600);
}

// `initialize` checks its terms, and that the contract holds its reserve.
#[test]
fn a_contract_starts_once_and_funded() {
    let env = TestEnvironment::default();
    let deployer = addr("deployer");
    env.setup_grant_storage_tokens(&deployer, NATIVE as i64);
    let code = register_mock_contract(&env);
    let token = addr("token");
    let bond = item();

    let started = env.transact(|tx| {
        tx.call(&deployer).run(AssertUnwindSafe(|| {
            let stream = deploy_contract(&sha256_static!("stream"), code.as_hash());
            let client = StreamClient::new(&stream);
            let start = |terms: Terms| {
                client
                    .try_initialize(terms)
                    .err()
                    .and_then(|e| e.try_as::<StreamError>())
            };
            let mut errors = vec![
                start(Terms {
                    token: ContractAddress::default(),
                    item_bond: bond,
                }),
                start(Terms {
                    token: stream,
                    item_bond: bond,
                }),
                start(Terms {
                    token,
                    item_bond: -1,
                }),
                start(Terms {
                    token,
                    item_bond: bond,
                }),
            ];
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&stream, reserve_needed(bond));
            errors.push(start(Terms {
                token,
                item_bond: bond,
            }));
            errors
        }))
    });
    started.assert_success();
    assert_eq!(
        started.assert_return_as::<Vec<Option<StreamError>>>(),
        vec![
            Some(StreamError::InvalidTerms),
            Some(StreamError::InvalidTerms),
            Some(StreamError::InvalidTerms),
            Some(StreamError::ReserveTooSmall),
            None,
        ]
    );
}

// What storing a stream's record costs, as the network prices it by default: the largest item a
// stream creates.
fn item() -> i128 {
    let record = Flow {
        payee: addr("payee"),
        rate: u64::MAX,
        start: u64::MAX,
        end: u64::MAX,
    };
    let len = encode_xdr(&record).expect("encodes").len();
    TestEnvironment::default()
        .get_current_cost_model()
        .bytestring_cost(len)
}

// Every payer opens a stream to a payee of its own, each ending at a different second, so that
// every one creates a payee's totals and a path of nodes. Then, later, every payer cancels.
// Returns how each open committed.
fn streams_everywhere(f: &Fixture, payers: &[String]) -> Vec<TryCommitResult> {
    let mut results = vec![];
    for (i, payer) in payers.iter().enumerate() {
        let payee = addr(&format!("payee-{i}"));
        let mut tx = f
            .pending(payer, |c| c.open(&payee, 1, 1, 1_000 + 37 * i as u64))
            .0;
        results.push(tx.try_commit_transaction());
    }
    f.env.advance_block();
    results
}

// With storage priced as the network prices it, and a bond of what a record costs to store, a
// crowd's streams cost the contract nothing: each brings a deposit for everything it creates.
// Cancelling deletes the record, and gives the payer back its bond.
#[test]
fn bonded_streams_pay_for_their_own_storage() {
    let payers = names("payer", 20);
    let bond = item();
    let f = Fixture::with_storage(&payers, Storage::Priced { item_bond: bond }, 0);

    let before = f.native(f.stream);
    let results = streams_everywhere(&f, &payers);
    assert!(results.iter().all(|r| *r == TryCommitResult::Ok));
    assert!(f.native(f.stream) >= before);
    let paid: Vec<i128> = payers.iter().map(|p| f.native(addr(p))).collect();
    for spent in &paid {
        // A record, a payee's four totals, and a path of nodes in each of its two trees.
        assert!(NATIVE - spent >= 5 * bond);
        assert!(NATIVE - spent <= (5 + 2 * 32) * bond);
    }

    // Every cancel lands in this one block. Together they refund more in bonds than the contract
    // holds beyond its reserve, but each gets back the deposit of the record it deletes when it
    // commits.
    for payer in &payers {
        let mut tx = f.pending(payer, |c| c.cancel(1)).0;
        assert_eq!(tx.try_commit_transaction(), TryCommitResult::Ok);
    }
    f.env.advance_block();
    assert!(f.native(f.stream) >= before);
    for (payer, spent) in payers.iter().zip(paid) {
        assert_eq!(f.native(addr(payer)), spent + bond);
    }
}

// Without the bond, every item a stream creates is a deposit out of the contract's own native
// tokens. A crowd that creates enough of them spends what the contract holds, and from then on
// streams that create anything are refused -- anyone's.
#[test]
fn without_a_bond_streams_drain_the_reserve() {
    let payers = names("payer", 20);
    let f = Fixture::with_storage(&payers, Storage::Priced { item_bond: 0 }, 40 * item());

    let results = streams_everywhere(&f, &payers);
    let refused: Vec<_> = results
        .into_iter()
        .filter(|r| *r != TryCommitResult::Ok)
        .collect();
    assert!(!refused.is_empty(), "the reserve covered every stream");
    for result in refused {
        assert_eq!(conflicts(&result), vec![DbConflictCode::InsufficientFunds]);
    }
}
