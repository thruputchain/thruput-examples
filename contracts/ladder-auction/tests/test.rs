use erc20::{ERC20Client, ERC20MetadataClient};
use ladder_auction::*;
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

// Sale-token base units in a lot.
const LOT: i128 = 100;

// The price of a lot at each level, in payment-token base units. Level 0 is the reserve.
const PRICES: [u64; 4] = [10, 20, 30, 40];

// Blocks are a second apart from START, and bidding closes an hour in.
const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const END: u64 = START + 3_600 * SECOND;

// What each bidder holds of the payment token, all of which the auction may take.
const FUNDS: i128 = 1_000_000;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn terms(sale: ContractAddress, pay: ContractAddress, supply: u64, min_lots: u64) -> Terms {
    Terms {
        sale_token: sale,
        payment_token: pay,
        lot_size: LOT,
        supply,
        min_lots,
        prices: VecM(PRICES.to_vec()),
        end: END,
        entry_bond: 0,
    }
}

// Whether storage is free, as in most of these tests, or priced as the network prices it, with
// a bond for each bidder entry.
#[derive(Clone, Copy)]
enum Storage {
    Free,
    Priced { entry_bond: i128 },
}

// The native tokens each party starts with when storage is priced: plenty for bonds, and for the
// tokens' own storage.
const NATIVE: i128 = 100_000_000;

struct Fixture {
    env: TestEnvironmentHandle,
    _codes: [MockContract; 2],
    auction: ContractAddress,
    sale: ContractAddress,
    pay: ContractAddress,
}

impl Fixture {
    // An auction of `supply` lots, with `bidders` funded and their allowances granted. Returns in
    // the first block of bidding.
    fn new(supply: u64, min_lots: u64, bidders: &[String]) -> Self {
        Self::with_storage(supply, min_lots, bidders, Storage::Free)
    }

    fn with_storage(supply: u64, min_lots: u64, bidders: &[String], storage: Storage) -> Self {
        let env = match storage {
            Storage::Free => TestEnvironment::no_cost(),
            Storage::Priced { .. } => TestEnvironment::default(),
        };
        let item = env.get_current_cost_model().nnint_cost();
        let entry_bond = match storage {
            Storage::Free => 0,
            Storage::Priced { entry_bond } => entry_bond,
        };
        let seller = addr("seller");
        let bidder_addrs: Vec<_> = bidders.iter().map(|b| addr(b)).collect();
        if let Storage::Priced { .. } = storage {
            // The native token pays for its own allowance rows, like any token.
            for who in bidder_addrs.iter().chain([&seller, &ADDRESS_NATIVE_TOKEN]) {
                env.setup_grant_storage_tokens(who, NATIVE as i64);
            }
        }
        env.advance_block_at(START.into());
        env.set_block_time_step(Some(Duration::from_secs(1)));

        let code = register_mock_contract(&env);
        let token_code = erc20::register_mock_contract(&env);
        let native = ERC20Client::new(&ADDRESS_NATIVE_TOKEN);
        // What priced storage costs these contracts: the tokens, a row for each holder, and the
        // auction, what `reserve_needed` asks for with a bond of one item.
        let (token_reserve, auction_reserve) = match storage {
            Storage::Free => (0, 0),
            Storage::Priced { .. } => (NATIVE / 10, reserve_needed(PRICES.len() as u32, item)),
        };

        let (mut auction, mut sale, mut pay) = (seller, seller, seller);
        env.transact(|tx| {
            tx.call(&seller).run(AssertUnwindSafe(|| {
                sale = deploy_contract(&sha256_static!("sale"), token_code.as_hash());
                pay = deploy_contract(&sha256_static!("pay"), token_code.as_hash());
                for token in [sale, pay] {
                    if token_reserve > 0 {
                        native.transfer(&token, token_reserve);
                    }
                    ERC20MetadataClient::new(&token).initialize(&seller, None, None, Some(2));
                }
                for bidder in &bidder_addrs {
                    ERC20Client::new(&pay).mint(bidder, FUNDS);
                }

                // Deploy and start the auction in one transaction, so nobody can start it first.
                let total = i128::from(supply) * LOT;
                ERC20Client::new(&sale).mint(&seller, total);
                auction = deploy_contract(&sha256_static!("auction"), code.as_hash());
                if auction_reserve > 0 {
                    native.transfer(&auction, auction_reserve);
                }
                ERC20Client::new(&sale).adjust_allowance(&auction, total);
                LadderAuctionClient::new(&auction).initialize(Terms {
                    entry_bond,
                    ..terms(sale, pay, supply, min_lots)
                });
            }))
        })
        .assert_success();
        // The tokens are visible to other transactions from the next block.
        env.advance_block();

        for bidder in bidder_addrs {
            env.transact(|tx| {
                tx.call(&bidder).run(move || {
                    ERC20Client::new(&pay).adjust_allowance(&auction, FUNDS);
                    if entry_bond > 0 {
                        ERC20Client::new(&ADDRESS_NATIVE_TOKEN)
                            .adjust_allowance(&auction, NATIVE / 2);
                    }
                })
            })
            .assert_success();
        }
        env.advance_block();

        Self {
            env,
            _codes: [code, token_code],
            auction,
            sale,
            pay,
        }
    }

    // Run `f` against the auction as `caller`, in the current block, and require it to succeed.
    fn call<R: WriteXDR>(
        &self,
        caller: &str,
        f: impl FnOnce(LadderAuctionClient) -> R,
    ) -> TransactResult {
        let auction = self.auction;
        let result = self.env.transact(|tx| {
            tx.call(&addr(caller))
                .run(AssertUnwindSafe(|| f(LadderAuctionClient::new(&auction))))
        });
        result.assert_success();
        result
    }

    fn bid(&self, bidder: &str, level: u32, lots: u64) {
        self.call(bidder, |c| c.bid(level, lots));
    }

    // Claim for `bidder`, as `caller`.
    fn claim(&self, caller: &str, bidder: &str) -> Settlement {
        let bidder = addr(bidder);
        self.call(caller, |c| c.claim(&bidder))
            .assert_return_as::<Settlement>()
    }

    fn clearing(&self) -> Clearing {
        self.call("viewer", |c| c.clearing())
            .assert_return_as::<Clearing>()
    }

    fn balance(&self, token: ContractAddress, holder: ContractAddress) -> i128 {
        let r = self.env.transact(|tx| {
            tx.call(&addr("viewer"))
                .run(move || ERC20Client::new(&token).get_balance_of(&holder))
        });
        r.assert_success();
        r.assert_return_as::<i128>()
    }

    // The sale-token and payment-token balances of `holder`.
    fn holds(&self, holder: &str) -> (i128, i128) {
        let holder = addr(holder);
        (
            self.balance(self.sale, holder),
            self.balance(self.pay, holder),
        )
    }

    // What the auction contract itself holds.
    fn auction_holds(&self) -> (i128, i128) {
        (
            self.balance(self.sale, self.auction),
            self.balance(self.pay, self.auction),
        )
    }

    // Move to the first block at or after the end.
    fn close(&self) {
        self.env.advance_block_at(END.into());
    }
}

fn names(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| n.to_string()).collect()
}

// The bids at or above level 2 ask for the whole supply, so level 2 clears: everyone filled pays
// its price, the bid above it is filled in full, the bid at it shares what is left, and the bid
// below it is refunded.
#[test]
fn bids_fill_from_the_top_at_one_price() {
    let f = Fixture::new(10, 1, &names(&["alice", "bob", "carol"]));
    f.bid("alice", 3, 6); // escrows 6 * 40
    f.bid("bob", 2, 6); // escrows 6 * 30
    f.bid("carol", 1, 4); // escrows 4 * 20
    f.env.advance_block();

    // Before the end, the clearing is what it would be if bidding closed now.
    let clearing = f.clearing();
    assert_eq!(
        clearing,
        Clearing {
            level: 2,
            price: 30,
            above: 6,
            at_level: 6,
            filled_at_level: 4,
            unsold: 0,
        }
    );
    assert!(clearing.rationed());

    f.close();
    assert_eq!(f.clearing(), clearing, "no bid came in after");
    let settle = |lots, paid, refund| Settlement {
        lots,
        paid,
        refund,
        bonds: 0,
    };
    assert_eq!(f.claim("alice", "alice"), settle(6, 6 * 30, 6 * 10));
    assert_eq!(f.claim("bob", "bob"), settle(4, 4 * 30, 6 * 30 - 4 * 30));
    assert_eq!(f.claim("carol", "carol"), settle(0, 0, 4 * 20));
    f.env.advance_block();

    assert_eq!(f.holds("alice"), (6 * LOT, FUNDS - 180));
    assert_eq!(f.holds("bob"), (4 * LOT, FUNDS - 120));
    assert_eq!(f.holds("carol"), (0, FUNDS));
    assert_eq!(f.holds("seller"), (0, 300));

    // Bob's six lots at the rationed level filled exactly four: nothing is left over.
    let returned = f.call("seller", |c| c.return_unsold());
    assert_eq!(returned.assert_return_as::<i128>(), 0);
    f.env.advance_block();
    assert_eq!(f.auction_holds(), (0, 0));
}

// Bids that do not ask for the whole supply are all filled at the reserve, and the rest goes back
// to the seller.
#[test]
fn an_undersubscribed_auction_clears_at_the_reserve() {
    let f = Fixture::new(10, 1, &names(&["alice", "bob"]));
    f.bid("alice", 3, 3);
    f.bid("bob", 1, 2);
    f.close();

    assert_eq!(
        f.clearing(),
        Clearing {
            level: 0,
            price: 10,
            above: 5,
            at_level: 0,
            filled_at_level: 0,
            unsold: 5,
        }
    );
    let settle = |lots, paid, refund| Settlement {
        lots,
        paid,
        refund,
        bonds: 0,
    };
    assert_eq!(f.claim("alice", "alice"), settle(3, 30, 3 * 40 - 30));
    assert_eq!(f.claim("bob", "bob"), settle(2, 20, 2 * 20 - 20));
    let returned = f.call("anyone", |c| c.return_unsold());
    assert_eq!(returned.assert_return_as::<i128>(), 5);
    f.env.advance_block();

    assert_eq!(f.holds("seller"), (5 * LOT, 50));
    assert_eq!(f.auction_holds(), (0, 0));
}

// Shares of a rationed level are rounded down. What that leaves over is known once every bid at
// the level is claimed -- and anyone may claim for anyone, so the seller need not wait for the
// bidders.
#[test]
fn what_rounding_leaves_over_returns_to_the_seller() {
    let f = Fixture::new(4, 1, &names(&["a", "b", "c"]));
    for bidder in ["a", "b", "c"] {
        f.bid(bidder, 2, 3);
    }
    f.close();

    // Nine lots ask for four: each three-lot bid is filled 3 * 4 / 9 = 1.33, rounded down to 1.
    assert_eq!(f.clearing().filled_at_level, 4);
    let unclaimed = |f: &Fixture| {
        let auction = f.auction;
        let r = f.env.transact(|tx| {
            tx.call(&addr("seller")).run(move || {
                LadderAuctionClient::new(&auction)
                    .try_return_unsold()
                    .unwrap_err()
                    .try_as()
                    == Some(AuctionError::RationedBidsUnclaimed)
            })
        });
        r.assert_success();
        assert!(r.assert_return_as::<bool>());
    };
    unclaimed(&f);

    let one = Settlement {
        lots: 1,
        paid: 30,
        refund: 60,
        bonds: 0,
    };
    assert_eq!(f.claim("seller", "a"), one);
    assert_eq!(f.claim("seller", "b"), one);
    f.env.advance_block();
    unclaimed(&f);

    assert_eq!(f.claim("seller", "c"), one);
    f.env.advance_block();
    let returned = f.call("seller", |c| c.return_unsold());
    assert_eq!(returned.assert_return_as::<i128>(), 1);
    f.env.advance_block();

    assert_eq!(f.holds("a"), (LOT, FUNDS - 30));
    assert_eq!(f.holds("seller"), (LOT, 90));
    assert_eq!(f.auction_holds(), (0, 0));

    let again = f.env.transact(|tx| {
        let auction = f.auction;
        tx.call(&addr("seller")).run(move || {
            LadderAuctionClient::new(&auction)
                .try_return_unsold()
                .unwrap_err()
                .try_as()
                == Some(AuctionError::AlreadyReturned)
        })
    });
    again.assert_success();
    assert!(again.assert_return_as::<bool>());
}

const CROWD: usize = 100;

fn crowd() -> Vec<String> {
    (0..CROWD).map(|i| format!("bidder-{i}")).collect()
}

// A crowd's bids: spread over the ladder, many at the same level.
fn crowd_bid(i: usize) -> (u32, u64) {
    ((i % PRICES.len()) as u32, 1 + (i % 7) as u64)
}

// Run every bid in the crowd in a single block, each executed before any commits, and commit them
// in the order `order` gives. Returns the fixture, closed.
fn auction_in_one_block(order: impl Iterator<Item = usize>) -> Fixture {
    let bidders = crowd();
    let f = Fixture::new(120, 1, &bidders);

    let mut pending: Vec<_> = bidders
        .iter()
        .enumerate()
        .map(|(i, bidder)| {
            let (level, lots) = crowd_bid(i);
            let auction = f.auction;
            let mut tx = f.env.transaction().build();
            tx.call(&addr(bidder))
                .run(move || LadderAuctionClient::new(&auction).bid(level, lots))
                .assert_success();
            Some(tx)
        })
        .collect();

    for i in order {
        let mut tx = pending[i].take().unwrap();
        assert_eq!(
            tx.try_commit_transaction(),
            TryCommitResult::Ok,
            "bid {i} conflicted"
        );
    }

    f.close();
    f
}

// A hundred bids in one block, none of which saw any other, all commit -- including many at the
// same level. And the order they commit in makes no difference to anything: two auctions whose
// blocks hold the same bids, committed in opposite orders, clear and settle identically.
#[test]
fn a_hundred_bids_in_one_block_commit_in_any_order() {
    let forward = auction_in_one_block(0..CROWD);
    let backward = auction_in_one_block((0..CROWD).rev());

    let mut demand = vec![0i128; PRICES.len()];
    for i in 0..CROWD {
        let (level, lots) = crowd_bid(i);
        demand[level as usize] += i128::from(lots);
    }
    for f in [&forward, &backward] {
        let curve = f.call("viewer", |c| c.demand());
        assert_eq!(curve.assert_return_as::<Lots>().0, demand);
    }

    let clearing = forward.clearing();
    assert_eq!(backward.clearing(), clearing);
    assert!(clearing.rationed(), "the crowd asks for more than there is");

    // The hundred claims land in one block too: claims for different bidders do not conflict.
    let mut sold = 0;
    for bidder in crowd() {
        let settled = forward.claim("seller", &bidder);
        assert_eq!(backward.claim("seller", &bidder), settled);
        sold += settled.lots;
    }

    // Every lot is either sold or returned, and the auction is left holding nothing.
    for f in [&forward, &backward] {
        f.env.advance_block();
        let returned = f.call("seller", |c| c.return_unsold());
        assert_eq!(sold + returned.assert_return_as::<i128>(), 120);
        f.env.advance_block();
        assert_eq!(f.auction_holds(), (0, 0));
    }
}

// Two of Alice's bids at one level, executed in one block and committed in order.
fn alice_twice(f: &Fixture, lots: [u64; 2]) -> [TryCommitResult; 2] {
    let auction = f.auction;
    let mut txs = lots.map(|lots| {
        let mut tx = f.env.transaction().build();
        tx.call(&addr("alice"))
            .run(move || LadderAuctionClient::new(&auction).bid(2, lots))
            .assert_success();
        tx
    });
    let results = [
        txs[0].try_commit_transaction(),
        txs[1].try_commit_transaction(),
    ];
    drop(txs);
    f.env.advance_block();
    results
}

// A bidder's first bid at a level opens its entry, exclusively, so the entry is bonded once: two
// first bids in one block conflict, and the second must be sent again. After that, even one
// bidder's bids at one level merge: two in one block both commit, and add up.
#[test]
fn a_bidders_entry_opens_once_and_then_merges() {
    let f = Fixture::new(10, 1, &names(&["alice"]));
    let [first, second] = alice_twice(&f, [3, 4]);
    assert_eq!(first, TryCommitResult::Ok);
    assert_eq!(conflicts(second), vec![DbConflictCode::ExclusiveLockDenied]);

    assert_eq!(
        alice_twice(&f, [1, 2]),
        [TryCommitResult::Ok, TryCommitResult::Ok]
    );

    let alice = addr("alice");
    let bids = f.call("viewer", |c| c.bids_of(&alice));
    assert_eq!(bids.assert_return_as::<Lots>().0, vec![0, 0, 3 + 1 + 2, 0]);
    assert_eq!(f.holds("alice").1, FUNDS - 6 * 30);
}

// The codes of the conflicts that kept a transaction out of its block.
fn conflicts(result: TryCommitResult) -> Vec<DbConflictCode> {
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

// Two claims for one bidder in one block both read the bids, but only one can delete them: the
// other cannot commit. The bidder is paid once, and later claims find nothing.
#[test]
fn a_bid_claimed_twice_in_one_block_settles_once() {
    let f = Fixture::new(10, 1, &names(&["alice", "bob"]));
    f.bid("alice", 3, 2);
    // Bob's escrow means the auction could pay Alice twice over: only the claim's own exclusive
    // delete stands in the way.
    f.bid("bob", 3, 8);
    f.close();

    let auction = f.auction;
    let alice = addr("alice");
    let mut a = f.env.transaction().build();
    let mut b = f.env.transaction().build();
    a.call(&alice)
        .run(move || LadderAuctionClient::new(&auction).claim(&alice))
        .assert_success();
    b.call(&addr("bob"))
        .run(move || LadderAuctionClient::new(&auction).claim(&alice))
        .assert_success();
    assert_eq!(a.try_commit_transaction(), TryCommitResult::Ok);
    assert_eq!(
        conflicts(b.try_commit_transaction()),
        vec![DbConflictCode::ExclusiveLockDenied]
    );
    drop((a, b));
    f.env.advance_block();

    // Bob's bid fills the supply at the top level, so that is the price.
    assert_eq!(f.holds("alice"), (2 * LOT, FUNDS - 2 * 40));
    let r = f.call("bob", move |c| {
        c.try_claim(&alice).unwrap_err().try_as() == Some(AuctionError::NothingToClaim)
    });
    assert!(r.assert_return_as::<bool>());
}

// Bids are taken before the end and settled after it, never both.
#[test]
fn bidding_closes_at_the_end() {
    let f = Fixture::new(10, 2, &names(&["alice"]));
    let alice = addr("alice");
    let refused = |result: Result<(), AuctionError>, expected| assert_eq!(result, Err(expected));
    let err = |e: CallError| e.try_as::<AuctionError>().unwrap();

    f.call("alice", |c| {
        refused(
            c.try_bid(4, 2).map(drop).map_err(err),
            AuctionError::NoSuchLevel,
        );
        refused(
            c.try_bid(0, 1).map(drop).map_err(err),
            AuctionError::BidTooSmall,
        );
        refused(
            c.try_claim(&alice).map(drop).map_err(err),
            AuctionError::BiddingOpen,
        );
        refused(
            c.try_return_unsold().map(drop).map_err(err),
            AuctionError::BiddingOpen,
        );
        c.bid(0, 2);
    });

    f.close();
    f.call("alice", |c| {
        refused(
            c.try_bid(0, 2).map(drop).map_err(err),
            AuctionError::BiddingClosed,
        );
        c.claim(&alice);
    });
}

// Terms nobody could bid in are refused, and an auction starts once.
#[test]
fn terms_are_checked_once() {
    let env = TestEnvironment::no_cost();
    env.advance_block_at(START.into());
    let code = register_mock_contract(&env);
    let (sale, pay) = (addr("sale"), addr("pay"));

    env.transact(|tx| {
        tx.call(&addr("seller")).run(AssertUnwindSafe(|| {
            let auction = deploy_contract(&sha256_static!("auction"), code.as_hash());
            let c = LadderAuctionClient::new(&auction);
            let good = terms(sale, pay, 10, 1);
            let invalid: [fn(&mut Terms); 9] = [
                |t| t.prices = VecM(vec![]),
                |t| t.prices = VecM(vec![0, 10]),
                |t| t.prices = VecM(vec![10, 20, 20]),
                |t| t.prices = VecM(vec![20, 10]),
                |t| t.lot_size = 0,
                |t| t.supply = 0,
                |t| t.min_lots = 0,
                |t| t.end = START,
                |t| t.payment_token = t.sale_token,
            ];
            for change in invalid {
                let mut bad = good.clone();
                change(&mut bad);
                assert_eq!(
                    c.try_initialize(bad).unwrap_err().try_as(),
                    Some(AuctionError::InvalidTerms)
                );
            }
            let mut own = good.clone();
            own.sale_token = auction;
            assert_eq!(
                c.try_initialize(own).unwrap_err().try_as(),
                Some(AuctionError::InvalidTerms)
            );

            // A bond means the auction must hold native tokens to refund bonds with, and this
            // one holds none.
            let bonded = Terms {
                entry_bond: 1,
                ..good
            };
            assert_eq!(
                c.try_initialize(bonded).unwrap_err().try_as(),
                Some(AuctionError::ReserveTooSmall)
            );
        }))
    })
    .assert_success();

    let f = Fixture::new(10, 1, &[]);
    let r = f.call("mallory", |c| {
        let again = terms(addr("sale"), addr("pay"), 10, 1);
        c.try_initialize(again).unwrap_err().try_as() == Some(AuctionError::AlreadyInitialized)
    });
    assert!(r.assert_return_as::<bool>());
}

// Every bidder bids a lot at every level, in one block, each bid its own transaction: so each
// opens an entry a level. Returns how each committed.
fn bid_everywhere(f: &Fixture, bidders: &[String]) -> Vec<TryCommitResult> {
    let auction = f.auction;
    let mut results = vec![];
    for bidder in bidders {
        for level in 0..PRICES.len() as u32 {
            let mut tx = f.env.transaction().build();
            tx.call(&addr(bidder))
                .run(move || LadderAuctionClient::new(&auction).bid(level, 1))
                .assert_success();
            results.push(tx.try_commit_transaction());
        }
    }
    f.env.advance_block();
    results
}

// What storing one balance costs, as the network prices it by default.
fn item() -> i128 {
    TestEnvironment::default()
        .get_current_cost_model()
        .nnint_cost()
}

// With storage priced as the network prices it, and a bond of what a bidder's entry costs to
// store, a crowd's bids cost the auction nothing: each brings its own deposit, and gets it back
// when it is claimed. (The demand totals they add to were created when the auction started.)
#[test]
fn bonded_bids_pay_for_their_own_storage() {
    let bidders: Vec<_> = (0..20).map(|i| format!("bidder-{i}")).collect();
    let bond = item();
    let f = Fixture::with_storage(1_000, 1, &bidders, Storage::Priced { entry_bond: bond });
    let native = |who| f.balance(ADDRESS_NATIVE_TOKEN, who);
    let levels = PRICES.len() as i128;

    let before = native(f.auction);
    let results = bid_everywhere(&f, &bidders);
    assert!(results.iter().all(|r| *r == TryCommitResult::Ok));
    assert_eq!(native(f.auction), before);
    assert_eq!(native(addr("bidder-0")), NATIVE - levels * bond);

    f.close();
    for bidder in &bidders {
        assert_eq!(f.claim("seller", bidder).bonds, levels * bond);
    }
    f.env.advance_block();
    assert_eq!(native(f.auction), before);
    for bidder in &bidders {
        assert_eq!(native(addr(bidder)), NATIVE);
    }
}

// Without the bond, every entry a bidder opens is a deposit out of the auction's own native
// tokens. A crowd that opens enough of them spends what the auction holds, and from then on bids
// that open an entry are refused -- anyone's.
#[test]
fn without_a_bond_bids_drain_the_reserve() {
    let bidders: Vec<_> = (0..20).map(|i| format!("bidder-{i}")).collect();
    let f = Fixture::with_storage(1_000, 1, &bidders, Storage::Priced { entry_bond: 0 });

    let results = bid_everywhere(&f, &bidders);
    let refused: Vec<_> = results
        .into_iter()
        .filter(|r| *r != TryCommitResult::Ok)
        .collect();
    assert!(!refused.is_empty(), "the reserve covered every entry");
    for result in refused {
        assert_eq!(conflicts(result), vec![DbConflictCode::InsufficientFunds]);
    }
}
