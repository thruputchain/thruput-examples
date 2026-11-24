use alloc::vec::Vec;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::deletable::Deletable;
use thruput_sdk::storage::{Array, Balance, CapacityConstraint, Map, Node, Value};
use thruput_sdk::*;

/// The most outcomes a market can have. A bet writes one headroom an outcome, and a claim reads
/// one position an outcome.
pub const MAX_OUTCOMES: u32 = 8;

/// Odds are decimal, in millionths: `2_500_000` pays 2.5 times the stake, the stake included.
pub const ODDS_ONE: u64 = 1_000_000;

/// The longest odds a market can quote: a thousand times the stake.
pub const MAX_ODDS: u64 = 1_000 * ODDS_ONE;

/// The odds on each outcome. Zero means the outcome is not offered.
pub type Odds = VecM<u64, MAX_OUTCOMES>;

/// An amount for each outcome.
pub type Amounts = VecM<i128, MAX_OUTCOMES>;

const OUTCOMES: usize = MAX_OUTCOMES as usize;

// The headrooms: one an outcome, and one more for the market being void.
const VOID: u32 = MAX_OUTCOMES;
const CASES: usize = OUTCOMES + 1;

/// What a market is, fixed when it starts.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    /// The token stakes, payouts and the bankroll are in. The native token works like any other.
    pub token: ContractAddress,

    /// Who says how the market ended: an oracle, or a party both sides trust. Bettors should
    /// check who it is. A house that resolved its own book could declare whichever outcome paid
    /// it most.
    pub resolver: ContractAddress,

    /// How many outcomes the market has, from 2 to [`MAX_OUTCOMES`]. Exactly one of them happens,
    /// or the market is void.
    pub outcomes: u32,

    /// When betting closes, as a block timepoint in Unix nanoseconds. A block at or past it
    /// takes no bets, and is the first in which the market can be resolved.
    pub close: u64,

    /// If the market is still unresolved at this timepoint, anyone may void it, and every stake
    /// goes back. It keeps a missing resolver from holding the stakes forever.
    pub resolve_by: u64,

    /// The smallest stake a bet may have.
    pub min_stake: i128,

    /// The native tokens a bettor deposits for each outcome it bets on, returned when its bets
    /// are claimed.
    ///
    /// A bettor's first bet on an outcome opens a position, two data items in this contract's
    /// storage, and storage is paid for out of this contract's native tokens until the position
    /// is deleted. The bond makes the bettor pay for it instead: set it to at least the network's
    /// cost of two data items. A bond of zero leaves the book paying for every position anyone
    /// opens, so that anyone could drain its native tokens with bets.
    pub entry_bond: i128,
}

#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Market {
    /// Who quotes the odds and holds the bankroll: whoever started the market.
    pub house: ContractAddress,
    pub terms: Terms,
}

/// How the market ended, if it has.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Not yet resolved.
    Open = 0,
    /// The outcome with this index happened.
    Won(u32) = 1,
    /// Called off: every stake is returned.
    Void = 2,
}

/// What the house would keep in each case: if each outcome won, and if the market were void.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Headroom {
    pub outcomes: Amounts,
    pub void: i128,
}

/// A bettor's position on one outcome: what it has staked on it, and what it would be paid if
/// it won, the stakes included.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Position {
    pub stake: i128,
    pub payout: i128,
}

/// What a claim paid one bettor.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Claim {
    /// In the market's token: the winning payout, or every stake back if the market is void.
    pub paid: i128,

    /// The bettor's entry bonds, in native tokens.
    pub bonds: i128,
}

#[contract_exception]
pub enum BookError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// The terms are not a market anyone could bet in: see `initialize`.
    InvalidTerms = 3,
    /// Odds that are neither zero nor within `ODDS_ONE..=MAX_ODDS`, or not one an outcome.
    InvalidOdds = 4,
    NotHouse = 5,
    NotResolver = 6,
    /// The block's timepoint is at or past the close.
    BettingClosed = 7,
    /// The block's timepoint is before the close: the market cannot be resolved yet.
    BettingOpen = 8,
    /// The market has been resolved or voided.
    NotOpen = 9,
    /// The market has not been resolved or voided yet.
    StillOpen = 10,
    NoSuchOutcome = 11,
    /// The house is not taking bets on this outcome: its odds are zero.
    NotOffered = 12,
    /// The odds on the outcome are below the bet's `min_odds`.
    OddsMoved = 13,
    StakeTooSmall = 14,
    /// The bet could win, or the withdrawal would take, more than the house has left in some case.
    NotEnoughHeadroom = 15,
    /// A negative bankroll, or an amount to fund or withdraw that is not positive.
    InvalidAmount = 16,
    /// An amount too large to represent.
    TooLarge = 17,
    /// The bettor has no positions left to claim.
    NothingToClaim = 18,
    AlreadySettled = 19,
    /// Nobody but the resolver may void the market before `resolve_by`.
    TooEarlyToVoid = 20,
    /// The book does not hold the native tokens `initialize` asks for.
    ReserveTooSmall = 21,
}

#[derive(Event, Clone, Debug)]
pub struct BetPlaced {
    #[topic]
    pub bettor: ContractAddress,
    #[topic]
    pub outcome: u32,
    pub stake: i128,
    pub odds: u64,
    pub payout: i128,
}

#[derive(Event, Clone, Debug)]
pub struct OddsSet {
    pub odds: Odds,
}

#[derive(Event, Clone, Debug)]
pub struct Resolved {
    pub outcome: Outcome,
}

#[derive(Event, Clone, Debug)]
pub struct Claimed {
    #[topic]
    pub bettor: ContractAddress,
    pub paid: i128,
    pub bonds: i128,
}

#[derive(Event, Clone, Debug)]
pub struct Settled {
    pub house: ContractAddress,
    pub amount: i128,
}

/// What a stake of `stake` pays at `odds`, the stake included, rounded down: in the house's
/// favour, never the bettor's. `None` if it does not fit.
pub fn payout(stake: i128, odds: u64) -> Option<i128> {
    let stake = u128::try_from(stake).ok()?;
    let paid = stake.checked_mul(u128::from(odds))? / u128::from(ODDS_ONE);
    i128::try_from(paid).ok()
}

/// The native tokens, in entry bonds, a book must hold when it starts.
///
/// Two bonds an outcome, and six more. A bond is meant to cover two data items, and `initialize`
/// stores a headroom for each outcome and one more, and four values: the terms are the largest,
/// at a few hundred bytes. One bond an outcome and six more covers that. The other bond an
/// outcome is room for a claim to refund a bettor's bonds: the positions the claim deletes give
/// their deposits back only when it commits, so the refund has to come out of tokens the book
/// already holds. Claims in the same block do not add up: each commit gets its own deposits back.
pub fn reserve_needed(outcomes: u32, entry_bond: i128) -> i128 {
    (2 * i128::from(outcomes) + 6).saturating_mul(entry_bond)
}

/// A bettor's [`Position`] on one outcome, as two balances that its bets add to.
#[derive(Storage)]
pub struct StoredPosition {
    stake: Balance,
    payout: Balance,
}

/// A fixed-odds book on one market, whose solvency the runtime checks across every block's bets.
///
/// The house quotes odds on each outcome and puts up a bankroll. For each outcome, the book keeps
/// its *headroom*: what the house would have left if that outcome won, after paying everyone who
/// backed it. A bet takes what it could win beyond its stake from its own outcome's headroom, and
/// adds its stake to every other outcome's, since the house keeps the stake if any of those wins.
/// Voiding the market is one more case, whose headroom is the bankroll: a void returns every
/// stake.
///
/// Each headroom is a `CapacityConstraint`. Bets never read and rewrite a liability total: they
/// only record what they take from and add to each headroom, and the runtime admits a block's
/// bets while every headroom stays at or above zero. So any number of bets land in a block, on
/// any outcomes, and the house can never owe more than the book holds, whatever the block holds.
///
/// Every bet in a block is priced at the odds as of the block's start. A bet cannot see another in
/// its block, so it cannot be priced off one, or run ahead of one.
#[thruput_sdk::storage]
pub struct FixedOdds {
    market: Value<Market>,

    // Read by every bet, and written only by the house. A new quote holds from the next block.
    odds: Value<Odds>,

    // What the house would keep in each case: an outcome each, and `VOID`. Set to the bankroll by
    // `initialize`, and from then on only consumed and released.
    headroom: Array<CapacityConstraint, CASES>,

    // Each bettor's position on each outcome: opened by its first bet there, added to by later
    // ones, and deleted by the claim that settles them.
    positions: Map<ContractAddress, Array<Node<StoredPosition>, OUTCOMES>>,

    // Written once to settle the market, with an exclusive lock: a resolution and a void in one
    // block cannot both commit.
    outcome: Value<Outcome>,

    settled: Value<bool>,
}

impl FixedOdds {
    fn load(&self) -> Market {
        self.market
            .try_get()
            .none_if_missing()
            .or_throw(BookError::NotInitialized)
    }

    fn load_as_house(&self) -> Market {
        let market = self.load();
        ensure(get_caller() == market.house, BookError::NotHouse);
        market
    }

    fn now() -> u64 {
        get_block_timepoint().into_inner()
    }

    fn require_open(&self) {
        ensure(self.outcome.get() == Outcome::Open, BookError::NotOpen);
    }

    fn valid(terms: &Terms, here: &ContractAddress) -> bool {
        (2..=MAX_OUTCOMES).contains(&terms.outcomes)
            && terms.close > Self::now()
            && terms.resolve_by > terms.close
            && terms.min_stake > 0
            && terms.entry_bond >= 0
            && terms.token != ContractAddress::default()
            && terms.token != *here
    }

    fn check_odds(odds: &Odds, outcomes: u32) {
        ensure(
            odds.len() == outcomes as usize
                && odds
                    .iter()
                    .all(|o| *o == 0 || (ODDS_ONE..=MAX_ODDS).contains(o)),
            BookError::InvalidOdds,
        );
    }

    // Take `amount` from case `case`'s headroom, if it has that much in this block: as of the
    // block's start, less what this transaction has already taken. That check gives a clear error
    // to what could never fit; whether a block's takings fit together is the runtime's check.
    fn take(&mut self, case: u32, amount: i128, error: BookError) {
        let mut room = self.headroom.at_mut(case);
        ensure(room.get_remaining_capacity() >= amount, error);
        room.consume_capacity(amount);
    }

    // Add `amount` to case `case`'s headroom. What a block adds is there from the next block: the
    // runtime checks a block's takings against the headroom as of its start.
    fn give(&mut self, case: u32, amount: i128) {
        self.headroom.at_mut(case).consume_capacity(-amount);
    }
}

#[contract(
    throws(BookError, thruput_erc20_if::ERC20Error),
    emits(BetPlaced, OddsSet, Resolved, Claimed, Settled)
)]
impl FixedOdds {
    /// Start the market: the caller is the house, quotes `odds`, and puts up `bankroll`, taken from
    /// it now on an allowance granted to this contract. Call it in the transaction that deploys
    /// the contract.
    ///
    /// The terms must name a token other than this contract, from 2 to [`MAX_OUTCOMES`] outcomes,
    /// a close in the future and a `resolve_by` after it, a positive minimum stake, and a bond that
    /// is not negative. The contract must already hold the native tokens [`reserve_needed`] asks
    /// for: send them to its address before deploying it, or earlier in the same transaction.
    pub fn initialize(&mut self, terms: Terms, bankroll: i128, odds: Odds) {
        ensure(
            self.market.try_get().none_if_missing().is_none(),
            BookError::AlreadyInitialized,
        );
        let here = get_current_address();
        ensure(Self::valid(&terms, &here), BookError::InvalidTerms);
        Self::check_odds(&odds, terms.outcomes);
        ensure(bankroll >= 0, BookError::InvalidAmount);
        ensure(
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&here)
                >= reserve_needed(terms.outcomes, terms.entry_bond),
            BookError::ReserveTooSmall,
        );

        let house = get_caller();
        self.market.set_exclusive(&Market {
            house,
            terms: terms.clone(),
        });
        self.odds.set(&odds);
        for case in (0..terms.outcomes).chain([VOID]) {
            self.headroom.at_mut(case).set_capacity(bankroll);
        }
        self.outcome.set(&Outcome::Open);
        self.settled.set(&false);
        if bankroll > 0 {
            ERC20Client::new(&terms.token).transfer_from(&house, &here, bankroll);
        }
        log_event(&OddsSet { odds });
    }

    /// Bet `stake` on `outcome`, at the odds quoted as of this block's start, if they are at least
    /// `min_odds`. The stake is taken on an allowance granted to this contract. Returns what the
    /// bet pays if the outcome wins, the stake included.
    ///
    /// A bettor's first bet on an outcome also takes the entry bond, in native tokens, on an
    /// allowance of those. Two first bets from one bettor on one outcome in one block cannot both
    /// commit: whichever does not can be sent again, and is then a later bet.
    pub fn bet(&mut self, outcome: u32, stake: i128, min_odds: u64) -> i128 {
        let terms = self.load().terms;
        ensure(Self::now() < terms.close, BookError::BettingClosed);
        self.require_open();
        ensure(outcome < terms.outcomes, BookError::NoSuchOutcome);
        ensure(stake >= terms.min_stake, BookError::StakeTooSmall);

        // The quote as of this block's start: every bet in the block gets the same odds.
        let odds = self.odds.get()[outcome as usize];
        ensure(odds != 0, BookError::NotOffered);
        ensure(odds >= min_odds, BookError::OddsMoved);
        let payout = payout(stake, odds).or_throw(BookError::TooLarge);

        // If `outcome` wins, the house pays out `payout`, having taken `stake`: it is down the
        // difference. If any other outcome wins, or the market is void and the stake goes back,
        // the house is up `stake`, or even. Neither the void case nor the stake read anything.
        self.take(outcome, payout - stake, BookError::NotEnoughHeadroom);
        for other in 0..terms.outcomes {
            if other != outcome {
                self.give(other, stake);
            }
        }

        let bettor = get_caller();
        let here = get_current_address();
        ERC20Client::new(&terms.token).transfer_from(&bettor, &here, stake);

        // The bettor's own position is the one thing a bet reads, and only to learn whether this
        // bet opens it. Opening takes the bond, and an exclusive lock, so a position is bonded
        // exactly once: two bets that both found it empty conflict.
        let mut mine = self.positions.at_mut(&bettor);
        let opens = mine.at(outcome).stake.get() == 0;
        let mut position = if opens {
            if terms.entry_bond > 0 {
                ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
                    &bettor,
                    &here,
                    terms.entry_bond,
                );
            }
            mine.at_mut_exclusive(outcome)
        } else {
            mine.at_mut(outcome)
        };
        position.stake.lazy_increase(stake);
        position.payout.lazy_increase(payout);

        log_event(&BetPlaced {
            bettor,
            outcome,
            stake,
            odds,
            payout,
        });
        payout
    }

    /// Quote new odds, one an outcome; zero suspends betting on an outcome. Bets in this block
    /// still get the old odds: the new ones hold from the next block. House only, before the
    /// close.
    pub fn set_odds(&mut self, odds: Odds) {
        let terms = self.load_as_house().terms;
        ensure(Self::now() < terms.close, BookError::BettingClosed);
        self.require_open();
        Self::check_odds(&odds, terms.outcomes);
        self.odds.set(&odds);
        log_event(&OddsSet { odds });
    }

    /// Add `amount` to the bankroll, taken on an allowance granted to this contract. It adds to
    /// every case's headroom, from the next block. House only, while the market is open.
    pub fn fund(&mut self, amount: i128) {
        let terms = self.load_as_house().terms;
        self.require_open();
        ensure(amount > 0, BookError::InvalidAmount);
        for case in (0..terms.outcomes).chain([VOID]) {
            self.give(case, amount);
        }
        ERC20Client::new(&terms.token).transfer_from(&get_caller(), &get_current_address(), amount);
    }

    /// Take `amount` out of the book. It comes out of every case's headroom, so the house can take
    /// only what it would have left whatever happened, the market being void included. The runtime
    /// checks that against the bets in the same block too. House only, while the market is open.
    pub fn withdraw(&mut self, amount: i128) {
        let Market { house, terms } = self.load_as_house();
        self.require_open();
        ensure(amount > 0, BookError::InvalidAmount);
        for case in (0..terms.outcomes).chain([VOID]) {
            self.take(case, amount, BookError::NotEnoughHeadroom);
        }
        ERC20Client::new(&terms.token).transfer(&house, amount);
    }

    /// Declare that `outcome` happened. Resolver only, once betting has closed, and once.
    pub fn resolve(&mut self, outcome: u32) {
        let terms = self.load().terms;
        ensure(get_caller() == terms.resolver, BookError::NotResolver);
        ensure(Self::now() >= terms.close, BookError::BettingOpen);
        self.require_open();
        ensure(outcome < terms.outcomes, BookError::NoSuchOutcome);
        self.finish(Outcome::Won(outcome));
    }

    /// Call the market off: every stake goes back, and the house's bankroll with it. The resolver
    /// may do this at any time; once `resolve_by` has passed with the market unresolved, anyone
    /// may.
    pub fn void(&mut self) {
        let terms = self.load().terms;
        ensure(
            get_caller() == terms.resolver || Self::now() >= terms.resolve_by,
            BookError::TooEarlyToVoid,
        );
        self.require_open();
        self.finish(Outcome::Void);
    }

    /// Pay `bettor` what its positions are owed now that the market is over -- the winning payout,
    /// or every stake if the market is void -- and its entry bonds back, deleting the positions.
    /// Anyone may claim for anyone, since the tokens only ever go to the bettor.
    pub fn claim(&mut self, bettor: &ContractAddress) -> Claim {
        let terms = self.load().terms;
        let outcome = self.outcome.get();
        ensure(outcome != Outcome::Open, BookError::StillOpen);

        let mut claim = Claim::default();
        let mut entries = 0;
        let mut mine = self.positions.at_mut(bettor);
        for index in 0..terms.outcomes {
            let mut position = mine.at_mut(index);
            let stake = position.stake.get();
            if stake == 0 {
                continue;
            }
            let owed = match outcome {
                Outcome::Won(won) if won == index => position.payout.get(),
                Outcome::Void => stake,
                _ => 0,
            };
            // The exclusive delete is what makes a claim happen once. Two claims for the same
            // bettor in one block both read these positions, but both cannot delete them: the
            // second conflicts, and cannot commit. In any later block, they are gone. (A plain
            // delete would not do: two deletes of one key do not conflict.)
            position.stake.delete_exclusive();
            position.payout.delete_exclusive();
            entries += 1;
            // Every payout and stake owed was paid in or covered by the headroom, so they fit.
            claim.paid += owed;
        }
        ensure(entries > 0, BookError::NothingToClaim);
        claim.bonds = entries * terms.entry_bond;

        if claim.paid > 0 {
            ERC20Client::new(&terms.token).transfer(bettor, claim.paid);
        }
        if claim.bonds > 0 {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(bettor, claim.bonds);
        }
        log_event(&Claimed {
            bettor: *bettor,
            paid: claim.paid,
            bonds: claim.bonds,
        });
        claim
    }

    /// Pay the house what it keeps, once the market is over: the headroom of what happened. That
    /// is the bankroll, plus every stake, less what the winners are owed; what the book still
    /// holds after it is exactly what their claims will take. Once. Anyone may call it, since the
    /// tokens only ever go to the house. Returns the amount.
    pub fn settle(&mut self) -> i128 {
        let Market { house, terms } = self.load();
        let case = match self.outcome.get() {
            Outcome::Open => throw(BookError::StillOpen),
            Outcome::Won(won) => won,
            Outcome::Void => VOID,
        };
        ensure(!self.settled.get(), BookError::AlreadySettled);

        // Exclusive, like a claim's delete: two settlements in one block cannot both commit. Once
        // the market is over, nothing writes a headroom, so this is final.
        self.settled.set_exclusive(&true);
        let amount = self.headroom.at(case).get_remaining_capacity();
        if amount > 0 {
            ERC20Client::new(&terms.token).transfer(&house, amount);
        }
        log_event(&Settled { house, amount });
        amount
    }

    pub fn market(&self) -> Market {
        self.load()
    }

    /// The odds quoted on each outcome, as of this block's start.
    pub fn odds(&self) -> Odds {
        self.odds.get()
    }

    /// How the market ended, if it has.
    pub fn outcome(&self) -> Outcome {
        self.outcome.get()
    }

    /// What the house would keep in each case, as of this block's start.
    pub fn headroom(&self) -> Headroom {
        let outcomes = self.load().terms.outcomes;
        let mut rooms = Vec::new();
        for outcome in 0..outcomes {
            rooms.push(self.headroom.at(outcome).get_remaining_capacity());
        }
        Headroom {
            outcomes: VecM(rooms),
            void: self.headroom.at(VOID).get_remaining_capacity(),
        }
    }

    /// `bettor`'s unclaimed position on `outcome`.
    pub fn position(&self, bettor: &ContractAddress, outcome: u32) -> Position {
        ensure(
            outcome < self.load().terms.outcomes,
            BookError::NoSuchOutcome,
        );
        let mine = self.positions.at(bettor);
        let position = mine.at(outcome);
        Position {
            stake: position.stake.get(),
            payout: position.payout.get(),
        }
    }

    pub fn is_settled(&self) -> bool {
        self.settled.get()
    }
}

impl FixedOdds {
    fn finish(&mut self, outcome: Outcome) {
        self.outcome.set_exclusive(&outcome);
        log_event(&Resolved { outcome });
    }
}
