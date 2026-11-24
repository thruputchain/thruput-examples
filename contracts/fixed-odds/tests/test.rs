use erc20::{ERC20Client, ERC20MetadataClient};
use fixed_odds::*;
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

// Blocks are a second apart from START. Betting closes an hour in, and the resolver has a day
// after that.
const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const CLOSE: u64 = START + 3_600 * SECOND;
const RESOLVE_BY: u64 = CLOSE + 86_400 * SECOND;

// Odds, in millionths.
const EVENS: u64 = 2 * ODDS_ONE;

// What the house and each bettor start with, all of which the book may take.
const FUNDS: i128 = 1_000_000;

// The native tokens each party starts with when storage is priced: plenty for bonds, and for the
// token's own storage.
const NATIVE: i128 = 100_000_000;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn names(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}-{i}")).collect()
}

fn named(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| n.to_string()).collect()
}

fn terms(token: ContractAddress, outcomes: u32) -> Terms {
    Terms {
        token,
        resolver: addr("resolver"),
        outcomes,
        close: CLOSE,
        resolve_by: RESOLVE_BY,
        min_stake: 1,
        entry_bond: 0,
    }
}

// Whether storage is free, as in most of these tests, or priced as the network prices it, with a
// bond for each position.
#[derive(Clone, Copy)]
enum Storage {
    Free,
    Priced { entry_bond: i128 },
}

struct Fixture {
    env: TestEnvironmentHandle,
    _codes: [MockContract; 2],
    book: ContractAddress,
    token: ContractAddress,
}

impl Fixture {
    // A market on `odds.len()` outcomes, with a bankroll of `bankroll`, and `bettors` funded and
    // their allowances granted. Returns in a block of open betting.
    fn new(bankroll: i128, odds: &[u64], bettors: &[String]) -> Self {
        Self::with_storage(bankroll, odds, bettors, Storage::Free)
    }

    fn with_storage(bankroll: i128, odds: &[u64], bettors: &[String], storage: Storage) -> Self {
        let env = match storage {
            Storage::Free => TestEnvironment::no_cost(),
            Storage::Priced { .. } => TestEnvironment::default(),
        };
        let entry_bond = match storage {
            Storage::Free => 0,
            Storage::Priced { entry_bond } => entry_bond,
        };
        let house = addr("house");
        let bettor_addrs: Vec<_> = bettors.iter().map(|b| addr(b)).collect();
        if let Storage::Priced { .. } = storage {
            // The native token pays for its own allowance rows, like any token.
            for who in bettor_addrs.iter().chain([&house, &ADDRESS_NATIVE_TOKEN]) {
                env.setup_grant_storage_tokens(who, NATIVE as i64);
            }
        }
        env.advance_block_at(START.into());
        env.set_block_time_step(Some(Duration::from_secs(1)));

        let code = register_mock_contract(&env);
        let token_code = erc20::register_mock_contract(&env);
        let native = ERC20Client::new(&ADDRESS_NATIVE_TOKEN);
        let outcomes = odds.len() as u32;
        // What priced storage costs these contracts: the token, a row for each holder, and the
        // book, what `reserve_needed` asks for with a bond of two items.
        let (token_reserve, book_reserve) = match storage {
            Storage::Free => (0, 0),
            Storage::Priced { .. } => (NATIVE / 10, reserve_needed(outcomes, 2 * item())),
        };

        let (mut book, mut token) = (house, house);
        env.transact(|tx| {
            tx.call(&house).run(AssertUnwindSafe(|| {
                token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
                if token_reserve > 0 {
                    native.transfer(&token, token_reserve);
                }
                ERC20MetadataClient::new(&token).initialize(&house, None, None, Some(2));
                ERC20Client::new(&token).mint(&house, FUNDS);
                for bettor in &bettor_addrs {
                    ERC20Client::new(&token).mint(bettor, FUNDS);
                }

                // Deploy and start the book in one transaction, so nobody can start it first.
                book = deploy_contract(&sha256_static!("book"), code.as_hash());
                if book_reserve > 0 {
                    native.transfer(&book, book_reserve);
                }
                ERC20Client::new(&token).adjust_allowance(&book, FUNDS);
                FixedOddsClient::new(&book).initialize(
                    Terms {
                        entry_bond,
                        ..terms(token, outcomes)
                    },
                    bankroll,
                    VecM(odds.to_vec()),
                );
            }))
        })
        .assert_success();
        // The tokens are visible to other transactions from the next block.
        env.advance_block();

        for bettor in bettor_addrs {
            env.transact(|tx| {
                tx.call(&bettor).run(move || {
                    ERC20Client::new(&token).adjust_allowance(&book, FUNDS);
                    if entry_bond > 0 {
                        ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&book, NATIVE / 2);
                    }
                })
            })
            .assert_success();
        }
        env.advance_block();

        Self {
            env,
            _codes: [code, token_code],
            book,
            token,
        }
    }

    // Run `f` against the book as `caller`, in the current block, and require it to succeed.
    fn call<R>(&self, caller: &str, f: impl FnOnce(FixedOddsClient) -> R) -> R
    where
        R: WriteXDR + xdr::ReadXDROwned,
    {
        let book = self.book;
        let result = self.env.transact(|tx| {
            tx.call(&addr(caller))
                .run(AssertUnwindSafe(|| f(FixedOddsClient::new(&book))))
        });
        result.assert_success();
        result.assert_return_as::<R>()
    }

    // The book error the call `f` makes fails with, as `caller`. `f` returns the call's error:
    // `|c| c.try_bet(0, 1, 0).err()`.
    fn refused(
        &self,
        caller: &str,
        f: impl FnOnce(FixedOddsClient) -> Option<CallError>,
    ) -> BookError {
        let book = self.book;
        let mut error = None;
        self.env
            .transact(|tx| {
                tx.call(&addr(caller)).run(AssertUnwindSafe(|| {
                    error = f(FixedOddsClient::new(&book));
                }))
            })
            .assert_success();
        error
            .expect("the call succeeded")
            .try_as::<BookError>()
            .expect("a book error")
    }

    // Bet `stake` on `outcome` at whatever odds are quoted, and require it to commit. Returns
    // what the bet pays if it wins.
    fn bet(&self, bettor: &str, outcome: u32, stake: i128) -> i128 {
        self.call(bettor, |c| c.bet(outcome, stake, 0))
    }

    // Execute `bettor`'s bet in the current block without committing it.
    fn pending_bet(&self, bettor: &str, outcome: u32, stake: i128) -> MockTransactionHandler {
        let book = self.book;
        let mut tx = self.env.transaction().build();
        tx.call(&addr(bettor))
            .run(move || FixedOddsClient::new(&book).bet(outcome, stake, 0))
            .assert_success();
        tx
    }

    fn headroom(&self) -> Headroom {
        self.call("viewer", |c| c.headroom())
    }

    fn position(&self, bettor: &str, outcome: u32) -> Position {
        let bettor = addr(bettor);
        self.call("viewer", |c| c.position(&bettor, outcome))
    }

    // Claim for `bettor`, as `caller`.
    fn claim(&self, caller: &str, bettor: &str) -> Claim {
        let bettor = addr(bettor);
        self.call(caller, |c| c.claim(&bettor))
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

    // What the book itself holds of the market's token.
    fn held(&self) -> i128 {
        self.balance_in(self.token, self.book)
    }

    fn native(&self, holder: ContractAddress) -> i128 {
        self.balance_in(ADDRESS_NATIVE_TOKEN, holder)
    }

    // Move to the first block at or after the close.
    fn close(&self) {
        self.env.advance_block_at(CLOSE.into());
    }

    // Close betting, and resolve the market to `outcome`, visible from the next block.
    fn close_and_resolve(&self, outcome: u32) {
        self.close();
        self.call("resolver", |c| c.resolve(outcome));
        self.env.advance_block();
    }
}

fn headroom(outcomes: &[i128], void: i128) -> Headroom {
    Headroom {
        outcomes: VecM(outcomes.to_vec()),
        void,
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

// A call that should be refused: who makes it, the call, and the error it should fail with.
type Refusal = (
    &'static str,
    fn(FixedOddsClient) -> Option<CallError>,
    BookError,
);

// What storing one balance costs, as the network prices it by default.
fn item() -> i128 {
    TestEnvironment::default()
        .get_current_cost_model()
        .nnint_cost()
}

// Each headroom is what the house keeps in that case. A winning bet is paid its odds, and the
// house settles for the winning outcome's headroom, which leaves the book holding exactly what the
// winners are owed.
#[test]
fn a_bet_wins_its_odds_and_the_house_keeps_the_rest() {
    let odds = 1_900_000; // 1.9: a margin of about 5% each way.
    let f = Fixture::new(1_000, &[odds, odds], &named(&["alice", "bob", "carol"]));
    assert_eq!(f.bet("alice", 0, 100), 190);
    assert_eq!(f.bet("bob", 1, 100), 190);
    assert_eq!(f.bet("carol", 0, 50), 95);
    f.env.advance_block();

    // If outcome 0 wins, the house pays 190 + 95 having taken 250 in stakes: 1,000 - 35. If 1
    // wins, it pays 190: 1,000 + 60. If the market is void, every stake goes back: 1,000.
    assert_eq!(f.headroom(), headroom(&[965, 1_060], 1_000));
    assert_eq!(
        f.position("alice", 0),
        Position {
            stake: 100,
            payout: 190,
        }
    );
    assert_eq!(f.position("alice", 1), Position::default());

    f.close_and_resolve(0);
    let won = |paid| Claim { paid, bonds: 0 };
    assert_eq!(f.claim("alice", "alice"), won(190));
    assert_eq!(f.claim("anyone", "carol"), won(95));
    assert_eq!(f.claim("bob", "bob"), won(0));
    assert_eq!(f.call("anyone", |c| c.settle()), 965);
    f.env.advance_block();

    assert_eq!(f.balance("alice"), FUNDS + 90);
    assert_eq!(f.balance("bob"), FUNDS - 100);
    assert_eq!(f.balance("carol"), FUNDS + 45);
    assert_eq!(f.balance("house"), FUNDS - 35);
    assert_eq!(f.held(), 0);
}

const CROWD: usize = 100;
const CROWD_ODDS: [u64; 3] = [EVENS, 3 * ODDS_ONE, 5 * ODDS_ONE];

// A crowd's bets: spread over the outcomes, many on the same one.
fn crowd_bet(i: usize) -> (u32, i128) {
    ((i % CROWD_ODDS.len()) as u32, 10 + (i % 7) as i128)
}

// Run every bet in the crowd in a single block, each executed before any commits, and commit them
// in the order `order` gives. Returns the fixture, in the next block.
fn book_in_one_block(order: impl Iterator<Item = usize>) -> Fixture {
    let bettors = names("bettor", CROWD);
    let f = Fixture::new(FUNDS, &CROWD_ODDS, &bettors);

    let mut pending: Vec<_> = (0..CROWD)
        .map(|i| {
            let (outcome, stake) = crowd_bet(i);
            Some(f.pending_bet(&bettors[i], outcome, stake))
        })
        .collect();
    for i in order {
        let mut tx = pending[i].take().unwrap();
        assert_eq!(
            tx.try_commit_transaction(),
            TryCommitResult::Ok,
            "bet {i} conflicted"
        );
    }
    f.env.advance_block();
    f
}

// A hundred bets in one block, none of which saw any other, all commit -- many on the same
// outcome, and every one of them writing every outcome's headroom. The order they commit in makes
// no difference: two books whose blocks hold the same bets, committed in opposite orders, end up
// the same, and settle the same.
#[test]
fn a_hundred_bets_land_in_one_block_in_any_order() {
    let forward = book_in_one_block(0..CROWD);
    let backward = book_in_one_block((0..CROWD).rev());

    let mut expected = vec![FUNDS; CROWD_ODDS.len()];
    for i in 0..CROWD {
        let (outcome, stake) = crowd_bet(i);
        for (case, room) in expected.iter_mut().enumerate() {
            if case == outcome as usize {
                *room -= payout(stake, CROWD_ODDS[case]).unwrap() - stake;
            } else {
                *room += stake;
            }
        }
    }
    for f in [&forward, &backward] {
        assert_eq!(f.headroom(), headroom(&expected, FUNDS));
    }
    for i in 0..CROWD {
        let bettor = format!("bettor-{i}");
        let (outcome, stake) = crowd_bet(i);
        let position = Position {
            stake,
            payout: payout(stake, CROWD_ODDS[outcome as usize]).unwrap(),
        };
        assert_eq!(forward.position(&bettor, outcome), position);
        assert_eq!(backward.position(&bettor, outcome), position);
    }

    // The hundred claims land in one block too: claims for different bettors do not conflict.
    let mut paid = 0;
    for f in [&forward, &backward] {
        f.close_and_resolve(1);
    }
    for i in 0..CROWD {
        let bettor = format!("bettor-{i}");
        let claim = forward.claim("house", &bettor);
        assert_eq!(backward.claim("house", &bettor), claim);
        paid += claim.paid;
    }
    for f in [&forward, &backward] {
        assert_eq!(f.call("house", |c| c.settle()), expected[1]);
        f.env.advance_block();
        assert_eq!(f.held(), 0);
    }
    let staked: i128 = (0..CROWD).map(|i| crowd_bet(i).1).sum();
    assert_eq!(paid + expected[1], FUNDS + staked);
}

// A one-sided rush on a long shot asks for more than the house can cover. Every bet passes the
// contract's own check, which sees the headroom as of the block's start; the runtime admits them
// while they fit together, and turns away the rest. Bets on the other outcome in the same block
// all land, but the stakes they add to the long shot's headroom count only from the next block.
#[test]
fn the_runtime_keeps_the_house_solvent() {
    let f = Fixture::new(100, &[3 * ODDS_ONE, 1_500_000], &names("bettor", 14));

    // Each bet of 10 on the long shot could win 30: the house risks 20 on it.
    let mut txs: Vec<_> = (0..10)
        .map(|i| f.pending_bet(&format!("bettor-{i}"), 0, 10))
        .collect();
    // Each bet of 10 on the favourite risks 5 on it, and gives the long shot 10.
    txs.extend((10..14).map(|i| f.pending_bet(&format!("bettor-{i}"), 1, 10)));
    let results = commit_all(txs);
    assert_eq!(admitted(&results[..10]), 5);
    for refused in results[..10].iter().filter(|r| **r != TryCommitResult::Ok) {
        assert_eq!(conflicts(refused), vec![DbConflictCode::BoundsExceeded]);
    }
    assert_eq!(admitted(&results[10..]), 4);
    f.env.advance_block();

    // The long shot's headroom is spent, and refilled by the favourite's stakes; the favourite's
    // is down 4 * 5 and up 5 * 10.
    assert_eq!(f.headroom(), headroom(&[40, 130], 100));

    // A bet that could never fit is refused by the contract, with a clear error.
    assert_eq!(
        f.refused("bettor-0", |c| c.try_bet(0, 21, 0).err()),
        BookError::NotEnoughHeadroom
    );
    // Now there is room for two more.
    assert_eq!(f.bet("bettor-5", 0, 10), 30);
    assert_eq!(f.bet("bettor-6", 0, 10), 30);
    f.env.advance_block();
    assert_eq!(f.headroom(), headroom(&[0, 150], 100));
}

// The house may take out what it would have left whatever happened -- and a void, which returns
// every stake, is one of the things that can happen. A balanced book has locked in a profit if
// either outcome wins, but until the market is resolved, the house can only take its bankroll.
#[test]
fn the_house_cannot_withdraw_what_a_void_would_refund() {
    let odds = 1_800_000;
    let f = Fixture::new(100, &[odds, odds], &names("bettor", 2));
    f.bet("bettor-0", 0, 100);
    f.bet("bettor-1", 1, 100);
    f.env.advance_block();

    // Either winner is paid 180 of the 200 staked: the house is up 20 whichever wins.
    assert_eq!(f.headroom(), headroom(&[120, 120], 100));
    assert_eq!(
        f.refused("house", |c| c.try_withdraw(101).err()),
        BookError::NotEnoughHeadroom
    );
    f.call("house", |c| c.withdraw(100));
    f.env.advance_block();
    assert_eq!(f.headroom(), headroom(&[20, 20], 0));

    // The event is called off. The book still holds every stake, and returns them.
    f.call("resolver", |c| c.void());
    f.env.advance_block();
    let refund = Claim {
        paid: 100,
        bonds: 0,
    };
    assert_eq!(f.claim("anyone", "bettor-0"), refund);
    assert_eq!(f.claim("anyone", "bettor-1"), refund);
    assert_eq!(f.call("anyone", |c| c.settle()), 0);
    f.env.advance_block();
    assert_eq!(f.held(), 0);
    assert_eq!(f.balance("house"), FUNDS);
}

// A withdrawal and a bet in one block, which together take more than an outcome has. Each passes
// its own check, and whichever commits second is turned away. The house can never take out what a
// bet in the same block needs.
#[test]
fn a_withdrawal_and_a_bet_cannot_overdraw_one_block() {
    for bet_first in [true, false] {
        let f = Fixture::new(100, &[EVENS, EVENS], &names("bettor", 1));
        let book = f.book;
        let bet = f.pending_bet("bettor-0", 0, 60);
        let mut withdraw = f.env.transaction().build();
        withdraw
            .call(&addr("house"))
            .run(move || FixedOddsClient::new(&book).withdraw(60))
            .assert_success();

        let results = if bet_first {
            commit_all(vec![bet, withdraw])
        } else {
            commit_all(vec![withdraw, bet])
        };
        assert_eq!(results[0], TryCommitResult::Ok);
        assert_eq!(conflicts(&results[1]), vec![DbConflictCode::BoundsExceeded]);
        f.env.advance_block();

        let expected = if bet_first {
            headroom(&[40, 160], 100)
        } else {
            headroom(&[40, 40], 40)
        };
        assert_eq!(f.headroom(), expected);
    }
}

// New odds do not reach the bets in their own block: those were priced as of the block's start.
// From the next block, they apply to everyone alike, and a bet can insist on a price.
#[test]
fn new_odds_hold_from_the_next_block() {
    for quote_first in [true, false] {
        let f = Fixture::new(1_000, &[EVENS, EVENS], &names("bettor", 3));
        let book = f.book;
        let early = f.pending_bet("bettor-0", 0, 10);
        let mut quote = f.env.transaction().build();
        quote
            .call(&addr("house"))
            .run(move || FixedOddsClient::new(&book).set_odds(VecM(vec![1_500_000, 0])))
            .assert_success();
        // Reading the quote and writing it do not conflict, in either order.
        let txs = if quote_first {
            vec![quote, early]
        } else {
            vec![early, quote]
        };
        assert_eq!(
            commit_all(txs),
            vec![TryCommitResult::Ok, TryCommitResult::Ok]
        );
        f.env.advance_block();
        assert_eq!(f.position("bettor-0", 0).payout, 20);

        assert_eq!(f.bet("bettor-1", 0, 10), 15);
        assert_eq!(
            f.refused("bettor-2", |c| c.try_bet(0, 10, EVENS).err()),
            BookError::OddsMoved
        );
        assert_eq!(
            f.refused("bettor-2", |c| c.try_bet(1, 10, 0).err()),
            BookError::NotOffered
        );
    }
}

// A bettor's first bet on an outcome opens its position, exclusively, so the position is bonded
// once: two first bets in one block conflict, and the second must be sent again. After that, even
// one bettor's bets on one outcome merge.
#[test]
fn a_position_opens_once_and_then_merges() {
    let f = Fixture::new(1_000, &[EVENS, EVENS], &names("bettor", 1));
    let twice = |stakes: [i128; 2]| {
        let results = commit_all(stakes.map(|s| f.pending_bet("bettor-0", 1, s)).into());
        f.env.advance_block();
        results
    };
    let first = twice([3, 4]);
    assert_eq!(first[0], TryCommitResult::Ok);
    // A position is two items, its stake and its payout, and both are locked.
    assert_eq!(
        conflicts(&first[1]),
        vec![DbConflictCode::ExclusiveLockDenied; 2]
    );

    assert_eq!(
        twice([1, 2]),
        vec![TryCommitResult::Ok, TryCommitResult::Ok]
    );
    assert_eq!(
        f.position("bettor-0", 1),
        Position {
            stake: 6,
            payout: 12,
        }
    );
}

// Two claims for one bettor in one block both read its positions, but only one can delete them:
// the other cannot commit. The bettor is paid once, and later claims find nothing.
#[test]
fn a_claim_pays_once() {
    let f = Fixture::new(1_000, &[EVENS, EVENS], &names("bettor", 2));
    f.bet("bettor-0", 0, 10);
    // Bob's losing stake means the book could pay Alice twice over: only the claim's own
    // exclusive delete stands in the way.
    f.bet("bettor-1", 1, 50);
    f.close_and_resolve(0);

    let book = f.book;
    let alice = addr("bettor-0");
    let claims: Vec<_> = ["bettor-0", "bettor-1"]
        .iter()
        .map(|caller| {
            let mut tx = f.env.transaction().build();
            tx.call(&addr(caller))
                .run(move || FixedOddsClient::new(&book).claim(&alice))
                .assert_success();
            tx
        })
        .collect();
    let results = commit_all(claims);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert_eq!(
        conflicts(&results[1]),
        vec![DbConflictCode::ExclusiveLockDenied; 2]
    );
    f.env.advance_block();

    assert_eq!(f.balance("bettor-0"), FUNDS + 10);
    assert_eq!(
        f.refused("bettor-1", |c| c.try_claim(&alice).err()),
        BookError::NothingToClaim
    );
}

// A voided market returns every stake, and the house its bankroll. Bets stop the moment the void
// is visible, even before the close.
#[test]
fn a_void_market_returns_every_stake() {
    let f = Fixture::new(
        500,
        &[EVENS, 4 * ODDS_ONE, 6 * ODDS_ONE],
        &names("bettor", 3),
    );
    f.bet("bettor-0", 0, 30);
    f.bet("bettor-1", 1, 20);
    f.bet("bettor-1", 2, 10);
    f.bet("bettor-2", 2, 40);
    f.env.advance_block();

    // The event is called off before the close.
    f.call("resolver", |c| c.void());
    f.env.advance_block();
    assert_eq!(f.call("viewer", |c| c.outcome()), Outcome::Void);
    assert_eq!(
        f.refused("bettor-0", |c| c.try_bet(0, 10, 0).err()),
        BookError::NotOpen
    );

    let refund = |paid| Claim { paid, bonds: 0 };
    assert_eq!(f.claim("anyone", "bettor-0"), refund(30));
    assert_eq!(f.claim("anyone", "bettor-1"), refund(30));
    assert_eq!(f.claim("anyone", "bettor-2"), refund(40));
    assert_eq!(f.call("anyone", |c| c.settle()), 500);
    f.env.advance_block();
    for bettor in ["bettor-0", "bettor-1", "bettor-2", "house"] {
        assert_eq!(f.balance(bettor), FUNDS);
    }
    assert_eq!(f.held(), 0);
}

// A resolver that never resolves cannot hold the stakes forever: once `resolve_by` passes, anyone
// may void the market.
#[test]
fn anyone_can_void_a_market_its_resolver_abandons() {
    let f = Fixture::new(500, &[EVENS, EVENS], &names("bettor", 1));
    f.bet("bettor-0", 1, 25);
    f.close();
    assert_eq!(
        f.refused("bettor-0", |c| c.try_void().err()),
        BookError::TooEarlyToVoid
    );

    f.env.advance_block_at(RESOLVE_BY.into());
    f.call("bettor-0", |c| c.void());
    f.env.advance_block();
    assert_eq!(f.claim("bettor-0", "bettor-0").paid, 25);
    assert_eq!(f.call("bettor-0", |c| c.settle()), 500);
}

// Bets are taken before the close and resolved after it, never both; each role does only its own
// part, and each step happens once.
#[test]
fn each_step_happens_once_and_in_turn() {
    let f = Fixture::new(500, &[EVENS, EVENS], &names("bettor", 1));
    let check = |cases: &[Refusal]| {
        for (caller, call, expected) in cases {
            assert_eq!(f.refused(caller, call), *expected);
        }
    };
    check(&[
        (
            "bettor-0",
            |c| c.try_bet(2, 10, 0).err(),
            BookError::NoSuchOutcome,
        ),
        (
            "bettor-0",
            |c| c.try_bet(0, 0, 0).err(),
            BookError::StakeTooSmall,
        ),
        (
            "bettor-0",
            |c| c.try_set_odds(VecM(vec![EVENS, EVENS])).err(),
            BookError::NotHouse,
        ),
        ("bettor-0", |c| c.try_withdraw(1).err(), BookError::NotHouse),
        ("house", |c| c.try_resolve(0).err(), BookError::NotResolver),
        (
            "resolver",
            |c| c.try_resolve(0).err(),
            BookError::BettingOpen,
        ),
        (
            "house",
            |c| c.try_set_odds(VecM(vec![EVENS])).err(),
            BookError::InvalidOdds,
        ),
        (
            "house",
            |c| c.try_set_odds(VecM(vec![EVENS, 999_999])).err(),
            BookError::InvalidOdds,
        ),
        ("anyone", |c| c.try_settle().err(), BookError::StillOpen),
    ]);
    let bettor = addr("bettor-0");
    assert_eq!(
        f.refused("anyone", |c| c.try_claim(&bettor).err()),
        BookError::StillOpen
    );
    f.bet("bettor-0", 0, 10);

    f.close();
    assert_eq!(
        f.refused("bettor-0", |c| c.try_bet(0, 10, 0).err()),
        BookError::BettingClosed
    );
    assert_eq!(
        f.refused("house", |c| c.try_set_odds(VecM(vec![EVENS, EVENS])).err()),
        BookError::BettingClosed
    );
    f.call("resolver", |c| c.resolve(1));
    f.env.advance_block();
    assert_eq!(f.call("viewer", |c| c.outcome()), Outcome::Won(1));
    check(&[
        ("resolver", |c| c.try_resolve(0).err(), BookError::NotOpen),
        ("resolver", |c| c.try_void().err(), BookError::NotOpen),
        ("house", |c| c.try_withdraw(1).err(), BookError::NotOpen),
        ("house", |c| c.try_fund(1).err(), BookError::NotOpen),
    ]);

    assert_eq!(f.call("anyone", |c| c.settle()), 510);
    f.env.advance_block();
    assert_eq!(
        f.refused("anyone", |c| c.try_settle().err()),
        BookError::AlreadySettled
    );
    assert_eq!(f.claim("anyone", "bettor-0").paid, 0);
    f.env.advance_block();
    assert_eq!(f.held(), 0);
}

// A resolution and a void in the same block cannot both commit: the market ends one way.
#[test]
fn a_market_ends_one_way() {
    let f = Fixture::new(500, &[EVENS, EVENS], &names("bettor", 1));
    f.env.advance_block_at(RESOLVE_BY.into());
    let book = f.book;
    let mut resolve = f.env.transaction().build();
    resolve
        .call(&addr("resolver"))
        .run(move || FixedOddsClient::new(&book).resolve(0))
        .assert_success();
    let mut void = f.env.transaction().build();
    void.call(&addr("anyone"))
        .run(move || FixedOddsClient::new(&book).void())
        .assert_success();
    let results = commit_all(vec![resolve, void]);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert_eq!(
        conflicts(&results[1]),
        vec![DbConflictCode::ExclusiveLockDenied]
    );
    f.env.advance_block();
    assert_eq!(f.call("viewer", |c| c.outcome()), Outcome::Won(0));
}

// The house can add to the bankroll while bets come in; it adds to every case's headroom.
#[test]
fn the_house_can_fund_the_book_at_any_time() {
    let f = Fixture::new(100, &[EVENS, EVENS], &names("bettor", 1));
    let book = f.book;
    let mut fund = f.env.transaction().build();
    fund.call(&addr("house"))
        .run(move || FixedOddsClient::new(&book).fund(400))
        .assert_success();
    let bet = f.pending_bet("bettor-0", 0, 100);
    assert_eq!(
        commit_all(vec![bet, fund]),
        vec![TryCommitResult::Ok, TryCommitResult::Ok]
    );
    f.env.advance_block();
    assert_eq!(f.headroom(), headroom(&[400, 600], 500));
    assert_eq!(f.balance("house"), FUNDS - 500);
}

// A market starts once, with terms anyone could bet in.
#[test]
fn terms_are_checked_once() {
    let env = TestEnvironment::no_cost();
    env.advance_block_at(START.into());
    let code = register_mock_contract(&env);
    let token_code = erc20::register_mock_contract(&env);
    let house = addr("house");

    let mut outcomes = vec![];
    env.transact(|tx| {
        tx.call(&house).run(AssertUnwindSafe(|| {
            let token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
            ERC20MetadataClient::new(&token).initialize(&house, None, None, Some(2));
            ERC20Client::new(&token).mint(&house, FUNDS);
            let book = deploy_contract(&sha256_static!("book"), code.as_hash());
            ERC20Client::new(&token).adjust_allowance(&book, FUNDS);
            let client = FixedOddsClient::new(&book);
            let good = terms(token, 2);
            let odds = || VecM(vec![EVENS, EVENS]);
            let mut start = |terms: Terms, bankroll: i128, odds: Odds| {
                outcomes.push(
                    client
                        .try_initialize(terms, bankroll, odds)
                        .err()
                        .and_then(|e| e.try_as::<BookError>()),
                );
            };
            start(
                Terms {
                    outcomes: 1,
                    ..good.clone()
                },
                100,
                VecM(vec![EVENS]),
            );
            start(
                Terms {
                    outcomes: MAX_OUTCOMES + 1,
                    ..good.clone()
                },
                100,
                odds(),
            );
            start(
                Terms {
                    close: START,
                    ..good.clone()
                },
                100,
                odds(),
            );
            start(
                Terms {
                    resolve_by: CLOSE,
                    ..good.clone()
                },
                100,
                odds(),
            );
            start(
                Terms {
                    min_stake: 0,
                    ..good.clone()
                },
                100,
                odds(),
            );
            start(
                Terms {
                    entry_bond: -1,
                    ..good.clone()
                },
                100,
                odds(),
            );
            start(
                Terms {
                    token: book,
                    ..good.clone()
                },
                100,
                odds(),
            );
            start(good.clone(), 100, VecM(vec![EVENS, MAX_ODDS + 1]));
            start(good.clone(), -1, odds());
            start(good.clone(), 100, odds());
            start(good, 100, odds());
        }))
    })
    .assert_success();
    let mut expected: Vec<_> = (0..7).map(|_| Some(BookError::InvalidTerms)).collect();
    expected.extend([
        Some(BookError::InvalidOdds),
        Some(BookError::InvalidAmount),
        None,
        Some(BookError::AlreadyInitialized),
    ]);
    assert_eq!(outcomes, expected);
}

// Every bettor bets a unit on every outcome, in one block, each bet its own transaction: so each
// opens a position an outcome. Returns how each committed.
fn bet_everywhere(f: &Fixture, bettors: &[String], outcomes: u32) -> Vec<TryCommitResult> {
    let mut results = vec![];
    for bettor in bettors {
        for outcome in 0..outcomes {
            let mut tx = f.pending_bet(bettor, outcome, 1);
            results.push(tx.try_commit_transaction());
        }
    }
    f.env.advance_block();
    results
}

// With storage priced as the network prices it, and a bond of what a position costs to store, a
// crowd's bets cost the book nothing: each brings its own deposit, and gets it back when it is
// claimed. (The headrooms they write were created when the market started.)
#[test]
fn bonded_bets_pay_for_their_own_storage() {
    let bettors = names("bettor", 20);
    let bond = 2 * item();
    let odds = [EVENS, EVENS, EVENS];
    let f = Fixture::with_storage(1_000, &odds, &bettors, Storage::Priced { entry_bond: bond });
    let outcomes = odds.len() as i128;

    let before = f.native(f.book);
    let results = bet_everywhere(&f, &bettors, odds.len() as u32);
    assert!(results.iter().all(|r| *r == TryCommitResult::Ok));
    assert_eq!(f.native(f.book), before);
    assert_eq!(f.native(addr("bettor-0")), NATIVE - outcomes * bond);

    // Resolving rewrites the outcome, a byte longer now: the book pays for that from its reserve.
    f.close_and_resolve(2);
    let resolved = f.native(f.book);
    // Every claim lands in this one block. Together they refund far more in bonds than the book
    // holds, but each gets back the deposits of the positions it deletes when it commits.
    assert!(resolved < bettors.len() as i128 * outcomes * bond);
    for bettor in &bettors {
        assert_eq!(
            f.claim("house", bettor),
            Claim {
                paid: 2,
                bonds: outcomes * bond,
            }
        );
    }
    f.env.advance_block();
    assert_eq!(f.native(f.book), resolved);
    for bettor in &bettors {
        assert_eq!(f.native(addr(bettor)), NATIVE);
    }
}

// Without the bond, every position a bettor opens is a deposit out of the book's own native
// tokens. A crowd that opens enough of them spends what the book holds, and from then on bets that
// open a position are refused -- anyone's.
#[test]
fn without_a_bond_bets_drain_the_reserve() {
    let bettors = names("bettor", 20);
    let odds = [EVENS, EVENS, EVENS];
    let f = Fixture::with_storage(1_000, &odds, &bettors, Storage::Priced { entry_bond: 0 });

    let results = bet_everywhere(&f, &bettors, odds.len() as u32);
    let refused: Vec<_> = results
        .into_iter()
        .filter(|r| *r != TryCommitResult::Ok)
        .collect();
    assert!(!refused.is_empty(), "the reserve covered every position");
    for result in refused {
        assert_eq!(conflicts(&result), vec![DbConflictCode::InsufficientFunds]);
    }
}
