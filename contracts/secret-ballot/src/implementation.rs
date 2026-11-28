use crate::group::*;
use crate::proofs::*;
use alloc::vec::Vec;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::storage::deletable::Deletable;
use thruput_sdk::storage::{Array, Map, NNInt, Node, RCQ, Value};
use thruput_sdk::*;

/// The most options a poll can offer. A ballot goes into a station's box as one queue entry, which
/// the protocol caps at 256 bytes: four ciphertexts of 64 bytes.
pub const MAX_OPTIONS: u32 = 4;

/// The most trustees a poll can have. Each holds a share of the key, and all of them are needed to
/// decrypt the totals.
pub const MAX_TRUSTEES: u32 = 7;

/// How many polling stations a poll has. Each is a ballot box that concurrent ballots go into, and
/// a box takes at most 250 ballots a block (the protocol's `kRetrocausalQueueBlockEntriesMaxLen`),
/// so a poll takes up to 2,000 a block.
pub const STATIONS: u32 = 8;

/// The most ballots one `count` takes out of a station's box.
pub const COUNT_BATCH: u32 = 250;

/// The most voters one `register` adds.
pub const MAX_REGISTER: u32 = 64;

pub(crate) const OPTIONS: usize = MAX_OPTIONS as usize;
const TRUSTEES: usize = MAX_TRUSTEES as usize;

// A count adds ballots up this many at a time, so it needs a fixed amount of guest memory however
// many it takes.
const CHUNK: usize = 15;

pub type Text = heapless::String<160>;
pub type OptionText = heapless::String<64>;

/// What a poll asks. Public, like everything else but the votes.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paper {
    pub question: Text,
    /// From 2 to [`MAX_OPTIONS`]. A ballot chooses exactly one.
    pub options: VecM<OptionText, MAX_OPTIONS>,
}

/// How a poll runs, fixed when it starts.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    /// Who holds the shares of the poll's key, from 1 to [`MAX_TRUSTEES`] distinct addresses.
    /// A ballot stays secret unless every one of them gives up their share. Voters should check
    /// who they are: a poll whose admin is its only trustee is a poll its admin can read.
    pub trustees: VecM<ContractAddress, MAX_TRUSTEES>,

    /// When voting ends, as a block timepoint in Unix nanoseconds. A block at or past it takes no
    /// ballots.
    pub close: u64,

    /// How long the trustees have to decrypt, in nanoseconds from the end of the count.
    pub decrypt_window: u64,

    /// The token trustees' bonds are in. Not the native token, unless the poll is funded with
    /// that in mind: a contract's native tokens are what its storage is paid from, so bonds held
    /// in them could be spent on the poll's storage.
    pub bond_token: ContractAddress,

    /// What each trustee deposits with its key. A trustee can reclaim it once the results are
    /// out, and loses it if the poll fails for want of its share.
    pub bond: i128,
}

#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Poll {
    /// Who registers the voters and opens the poll: whoever started it.
    pub admin: ContractAddress,
    pub paper: Paper,
    pub terms: Terms,
}

#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// The admin registers voters and the trustees submit their keys.
    Setup = 0,
    /// Registered voters cast ballots until the close. Counting can start as soon as ballots do.
    Voting = 1,
    /// Every ballot is counted, and the trustees are decrypting the totals.
    Counted = 2,
    /// The results are out.
    Published = 3,
    /// The poll never opened, or a trustee never decrypted.
    Failed = 4,
}

#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub phase: Phase,
    /// The poll's public key, the sum of the trustees' keys. Set when the poll opens.
    pub key: Point,
    /// When the count finished, which starts the trustees' window. Zero until then.
    pub counted_at: u64,
}

/// One option's part of a ballot: a ciphertext of 0 or 1, and the proof that it is one of those.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Choice {
    pub ciphertext: Ciphertext,
    pub proof: BitProof,
}

/// A ballot: one choice an option, and a proof that exactly one of them is a 1.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ballot {
    pub choices: VecM<Choice, MAX_OPTIONS>,
    pub proof: Proof,
}

/// A ciphertext an option. This is what a station's box holds for each ballot, with the proofs
/// left behind once they are checked. It is also what a running total is: adding ballots adds
/// their ciphertexts. Options a poll does not offer stay at the encryption of zero, `(0, 0)`.
pub type Ciphertexts = [Ciphertext; OPTIONS];

/// A trustee's part in decrypting one option's total: `x·A` for its key `x·G` and the total
/// `(A, B)`, with the proof that it used the same `x`.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Share {
    pub share: Point,
    pub proof: Proof,
}

#[contract_exception]
pub enum BallotError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// The paper or terms are not a poll anyone could run: see `initialize`.
    InvalidTerms = 3,
    NotAdmin = 4,
    NotTrustee = 5,
    /// The poll is not in the phase this needs.
    WrongPhase = 6,
    /// The block's timepoint is at or past the close.
    VotingClosed = 7,
    /// The block's timepoint is before the close.
    VotingOpen = 8,
    NotRegistered = 9,
    AlreadyVoted = 10,
    NoSuchStation = 11,
    /// A ballot with the wrong number of choices, or shares for the wrong number of options.
    WrongLength = 12,
    /// A proof does not check out.
    InvalidProof = 13,
    /// The poll cannot open until every trustee has submitted a key.
    KeysMissing = 14,
    /// This trustee has already submitted its key, or its shares.
    AlreadySubmitted = 15,
    /// Some ballots are still waiting in a station's box.
    StillCounting = 16,
    /// The trustees' window has closed.
    WindowClosed = 17,
    /// The results cannot be published until every trustee has decrypted.
    SharesMissing = 18,
    /// The counts are not what the totals decrypt to.
    WrongCounts = 19,
    /// The poll cannot be failed yet.
    TooEarly = 20,
    /// Every trustee has decrypted, so the poll can be published: it cannot fail.
    SharesComplete = 21,
    /// The trustee has no bond to reclaim: it has already, or the poll is not over, or it lost
    /// the bond by not decrypting.
    NoBond = 22,
}

#[derive(Event, Clone, Debug)]
pub struct Opened {
    pub key: Point,
    pub electorate: i128,
}

#[derive(Event, Clone, Debug)]
pub struct BallotCast {
    #[topic]
    pub voter: ContractAddress,
    pub station: u32,
}

#[derive(Event, Clone, Debug)]
pub struct BallotsCounted {
    #[topic]
    pub station: u32,
    pub ballots: u32,
}

#[derive(Event, Clone, Debug)]
pub struct Published {
    pub counts: VecM<u64, MAX_OPTIONS>,
}

#[derive(Event, Clone, Debug)]
pub struct Failed {
    /// The trustees whose bonds were kept: those who never decrypted.
    pub forfeited: VecM<ContractAddress, MAX_TRUSTEES>,
}

/// A polling station: a box that ballots go into, and the running total of those taken out.
#[derive(Storage)]
pub struct Station {
    // Inserts commute, so any number of ballots can go in at once, up to 250 a block. Only one
    // transaction a block can take from it.
    ballots: RCQ<Ciphertexts>,
    total: Value<Ciphertexts>,
    counted: Value<u64>,
}

/// A trustee's key, its bond until reclaimed, and later its shares of the totals.
#[derive(Storage)]
pub struct Trustee {
    key: Value<Point>,
    bonded: Value<bool>,
    shares: Value<VecM<Point, MAX_OPTIONS>>,
}

/// A poll whose ballots are encrypted, and whose totals are decrypted in public.
///
/// A voter encrypts its ballot to the poll's key and proves, in zero knowledge, that the ballot
/// chooses exactly one option. The contract checks the proofs, and drops the ciphertexts into one
/// of eight stations' boxes. Since encryption in the exponent adds up what it hides, counting is
/// adding: anyone can take ballots out of a box and add them to the station's running total,
/// without learning anything. Once every ballot is counted, each trustee decrypts its share of the
/// totals and proves it did so honestly, and anyone can publish the counts the totals decrypt to.
///
/// No step reads another voter's state. A ballot writes the voter's own flag, a box entry, and a
/// mergeable turnout, so ballots in a block never conflict with one another.
#[thruput_sdk::storage]
pub struct SecretBallot {
    poll: Value<Poll>,
    state: Value<State>,

    // Each registered voter, and whether it has voted. Written once more, exclusively, by its
    // ballot.
    roll: Map<ContractAddress, Value<bool>>,
    electorate: NNInt,
    // Every ballot adds one, and the increments merge.
    turnout: NNInt,

    stations: Array<Node<Station>, { STATIONS as usize }>,
    trustees: Array<Node<Trustee>, TRUSTEES>,

    // The stations' totals added together, once the count has finished.
    totals: Value<Ciphertexts>,
    results: Value<VecM<u64, MAX_OPTIONS>>,
}

impl SecretBallot {
    fn load(&self) -> Poll {
        self.poll
            .try_get()
            .none_if_missing()
            .or_throw(BallotError::NotInitialized)
    }

    fn now() -> u64 {
        get_block_timepoint().into_inner()
    }

    fn require(&self, phase: Phase) -> State {
        let state = self.state.get();
        ensure(state.phase == phase, BallotError::WrongPhase);
        state
    }

    fn trustee_index(terms: &Terms, who: &ContractAddress) -> u32 {
        terms
            .trustees
            .iter()
            .position(|t| t == who)
            .or_throw(BallotError::NotTrustee) as u32
    }

    fn valid(paper: &Paper, terms: &Terms) -> bool {
        let trustees = &terms.trustees;
        (2..=OPTIONS).contains(&paper.options.len())
            && !paper.question.trim().is_empty()
            && paper.options.iter().all(|o| !o.trim().is_empty())
            && !trustees.is_empty()
            && trustees
                .iter()
                .enumerate()
                .all(|(i, t)| *t != ContractAddress::default() && !trustees[..i].contains(t))
            && terms.close > Self::now()
            && terms.decrypt_window > 0
            && terms.bond >= 0
            && terms.bond_token != get_current_address()
    }
}

#[contract(
    throws(BallotError, thruput_erc20_if::ERC20Error),
    emits(Opened, BallotCast, BallotsCounted, Published, Failed)
)]
impl SecretBallot {
    /// Start a poll. The caller is its admin. Call it in the transaction that deploys the
    /// contract, which holds one poll.
    ///
    /// The paper must ask a question with 2 to [`MAX_OPTIONS`] options, none of them blank. The
    /// terms must name 1 to [`MAX_TRUSTEES`] distinct trustees, a close in the future, a decrypt
    /// window, and a bond that is not negative, in a token other than this contract.
    pub fn initialize(&mut self, paper: Paper, terms: Terms) {
        ensure(
            self.poll.try_get().none_if_missing().is_none(),
            BallotError::AlreadyInitialized,
        );
        ensure(Self::valid(&paper, &terms), BallotError::InvalidTerms);
        self.poll.set_exclusive(&Poll {
            admin: get_caller(),
            paper,
            terms,
        });
        self.state.set(&State {
            phase: Phase::Setup,
            key: IDENTITY,
            counted_at: 0,
        });
        self.electorate.set(0);
        // Created now, so that the first ballots in a block do not each pay to create it.
        self.turnout.set(0);
        for station in 0..STATIONS {
            let mut station = self.stations.at_mut(station);
            station.total.set(&[Ciphertext::default(); OPTIONS]);
            station.counted.set(&0);
        }
    }

    /// Add `voters` to the roll, and return how many were not on it already. Admin only, before
    /// the poll opens: opening freezes the roll.
    ///
    /// Each voter is an entry in this contract's storage, paid for out of its native tokens, so
    /// the roll is the admin's to fund. Nobody else can add to what the poll stores but by voting,
    /// and a ballot adds only a box entry, which the count removes.
    pub fn register(&mut self, voters: VecM<ContractAddress, MAX_REGISTER>) -> u32 {
        let poll = self.load();
        ensure(get_caller() == poll.admin, BallotError::NotAdmin);
        self.require(Phase::Setup);
        let mut added = 0;
        for voter in voters.iter() {
            let mut entry = self.roll.at_mut(voter);
            if entry.try_get().none_if_missing().is_none() {
                // Exclusive, so two registrations of one voter in a block cannot both count it.
                entry.set_exclusive(&false);
                added += 1;
            }
        }
        self.electorate.inc(i128::from(added));
        added
    }

    /// Submit the caller's key share, `key = x·G`, with a proof that it knows `x`, and deposit
    /// the bond, on an allowance granted to this contract. Trustees only, once each, before the
    /// poll opens.
    pub fn submit_key(&mut self, key: Point, proof: Proof) {
        let terms = self.load().terms;
        self.require(Phase::Setup);
        ensure(Self::now() < terms.close, BallotError::VotingClosed);
        let trustee = get_caller();
        let index = Self::trustee_index(&terms, &trustee);
        let mut slot = self.trustees.at_mut(index);
        ensure(
            slot.key.try_get().none_if_missing().is_none(),
            BallotError::AlreadySubmitted,
        );
        ensure(
            key != IDENTITY && key_is_known(&trustee, &key, &proof),
            BallotError::InvalidProof,
        );
        slot.key.set_exclusive(&key);
        if terms.bond > 0 {
            slot.bonded.set(&true);
            ERC20Client::new(&terms.bond_token).transfer_from(
                &trustee,
                &get_current_address(),
                terms.bond,
            );
        }
    }

    /// Open the poll for voting, with the sum of the trustees' keys as its key. Admin only, once
    /// every trustee has submitted one, and before the close.
    pub fn open(&mut self) {
        let poll = self.load();
        ensure(get_caller() == poll.admin, BallotError::NotAdmin);
        self.require(Phase::Setup);
        ensure(Self::now() < poll.terms.close, BallotError::VotingClosed);
        let mut key = Sum::<TRUSTEES>::new();
        for index in 0..poll.terms.trustees.len() as u32 {
            let share = self.trustees.at(index).key.try_get().none_if_missing();
            key.add(&ONE, &share.or_throw(BallotError::KeysMissing));
        }
        let key = key.eval().or_throw(BallotError::InvalidProof);
        self.state.set_exclusive(&State {
            phase: Phase::Voting,
            key,
            counted_at: 0,
        });
        log_event(&Opened {
            key,
            electorate: self.electorate.get(),
        });
    }

    /// Cast the caller's ballot into `station`'s box. Registered voters only, once each, while
    /// the poll is open.
    ///
    /// Any station will do, since they are all counted. A box takes at most 250 ballots a block,
    /// and a ballot past that is left out of its block at commit, with nothing written: a client
    /// should pick a station at random, and send a ballot that was left out again to another.
    pub fn cast(&mut self, station: u32, ballot: Ballot) {
        let poll = self.load();
        let state = self.require(Phase::Voting);
        ensure(Self::now() < poll.terms.close, BallotError::VotingClosed);
        ensure(station < STATIONS, BallotError::NoSuchStation);
        let voter = get_caller();
        let mut entry = self.roll.at_mut(&voter);
        let voted = entry
            .try_get()
            .none_if_missing()
            .or_throw(BallotError::NotRegistered);
        ensure(!voted, BallotError::AlreadyVoted);

        let options = poll.paper.options.len();
        ensure(ballot.choices.len() == options, BallotError::WrongLength);
        let mut sealed = [Ciphertext::default(); OPTIONS];
        for (option, choice) in ballot.choices.iter().enumerate() {
            ensure(
                is_bit(
                    &voter,
                    option as u32,
                    &state.key,
                    &choice.ciphertext,
                    &choice.proof,
                ),
                BallotError::InvalidProof,
            );
            sealed[option] = choice.ciphertext;
        }
        ensure(
            is_one_choice(&voter, &state.key, &sealed[..options], &ballot.proof),
            BallotError::InvalidProof,
        );

        // Exclusive, so two ballots from one voter in a block cannot both commit.
        entry.set_exclusive(&true);
        self.stations.at_mut(station).ballots.insert(&sealed);
        self.turnout.inc(1);
        log_event(&BallotCast { voter, station });
    }

    /// Take up to [`COUNT_BATCH`] ballots out of `station`'s box and add them to its total.
    /// Returns how many. Anyone may count, as soon as the poll opens: a total can only be read
    /// with every trustee's share, and the trustees decrypt only once the count is over.
    ///
    /// Only one count a station can commit in a block; another in the same block is left out at
    /// commit. Counts at different stations never conflict. A count takes all it can, up to the
    /// batch, so holding a station's place in a block cannot slow its count down.
    pub fn count(&mut self, station: u32) -> u32 {
        let options = self.load().paper.options.len();
        self.require(Phase::Voting);
        ensure(station < STATIONS, BallotError::NoSuchStation);
        let mut slot = self.stations.at_mut(station);
        let mut total = slot.total.get();
        let mut taken = 0;
        while taken < COUNT_BATCH {
            let mut chunk = [[Ciphertext::default(); OPTIONS]; CHUNK];
            let mut n = 0;
            while n < CHUNK && taken + (n as u32) < COUNT_BATCH {
                match slot.ballots.try_consume().none_if_missing() {
                    Some(ballot) => chunk[n] = ballot,
                    None => break,
                }
                n += 1;
            }
            if n == 0 {
                break;
            }
            for option in 0..options {
                let (mut a, mut b) = (Sum::<{ CHUNK + 1 }>::new(), Sum::<{ CHUNK + 1 }>::new());
                a.add(&ONE, &total[option].a);
                b.add(&ONE, &total[option].b);
                for ballot in &chunk[..n] {
                    a.add(&ONE, &ballot[option].a);
                    b.add(&ONE, &ballot[option].b);
                }
                // Every point was checked when its ballot was cast.
                total[option] = Ciphertext {
                    a: a.eval().or_throw(BallotError::InvalidProof),
                    b: b.eval().or_throw(BallotError::InvalidProof),
                };
            }
            taken += n as u32;
            if n < CHUNK {
                break;
            }
        }
        // A count that found the box empty writes nothing, so it conflicts with nothing.
        if taken > 0 {
            slot.total.set(&total);
            let counted = slot.counted.get();
            slot.counted.set(&(counted + u64::from(taken)));
            log_event(&BallotsCounted {
                station,
                ballots: taken,
            });
        }
        taken
    }

    /// Finish the count: add the stations' totals together, and start the trustees' window.
    /// Anyone may call it, once the poll has closed and every ballot cast has been counted.
    pub fn finish_count(&mut self) {
        let poll = self.load();
        let mut state = self.require(Phase::Voting);
        ensure(Self::now() >= poll.terms.close, BallotError::VotingOpen);
        // Every ballot was cast before the close, in an earlier block, so the turnout is final.
        let counted: u64 = (0..STATIONS)
            .map(|s| self.stations.at(s).counted.get())
            .sum();
        ensure(
            i128::from(counted) == self.turnout.get(),
            BallotError::StillCounting,
        );
        let mut totals = [Ciphertext::default(); OPTIONS];
        for (option, total) in totals.iter_mut().enumerate().take(poll.paper.options.len()) {
            let (mut a, mut b) = (
                Sum::<{ STATIONS as usize }>::new(),
                Sum::<{ STATIONS as usize }>::new(),
            );
            for station in 0..STATIONS {
                let station = self.stations.at(station).total.get();
                a.add(&ONE, &station[option].a);
                b.add(&ONE, &station[option].b);
            }
            *total = Ciphertext {
                a: a.eval().or_throw(BallotError::InvalidProof),
                b: b.eval().or_throw(BallotError::InvalidProof),
            };
        }
        self.totals.set(&totals);
        state.phase = Phase::Counted;
        state.counted_at = Self::now();
        self.state.set_exclusive(&state);
    }

    /// Submit the caller's share of decrypting each option's total, each with its proof.
    /// Trustees only, once each, within the window after the count.
    pub fn decrypt(&mut self, shares: VecM<Share, MAX_OPTIONS>) {
        let Poll { paper, terms, .. } = self.load();
        let state = self.require(Phase::Counted);
        ensure(
            Self::now() < state.counted_at.saturating_add(terms.decrypt_window),
            BallotError::WindowClosed,
        );
        ensure(
            shares.len() == paper.options.len(),
            BallotError::WrongLength,
        );
        let totals = self.totals.get();
        let trustee = get_caller();
        let index = Self::trustee_index(&terms, &trustee);
        let mut slot = self.trustees.at_mut(index);
        ensure(
            slot.shares.try_get().none_if_missing().is_none(),
            BallotError::AlreadySubmitted,
        );
        let key = slot.key.get();
        let mut points = Vec::new();
        for (option, share) in shares.iter().enumerate() {
            ensure(
                is_share(
                    &trustee,
                    option as u32,
                    &key,
                    &totals[option].a,
                    &share.share,
                    &share.proof,
                ),
                BallotError::InvalidProof,
            );
            points.push(share.share);
        }
        slot.shares.set_exclusive(&VecM(points));
    }

    /// Publish what each option's total decrypts to. Anyone may, once every trustee has
    /// decrypted: the counts are small, so they can be found by trying each in turn, and the
    /// contract checks them.
    ///
    /// For each option, with total `(A, B)` and shares `Dᵢ = xᵢ·A`: `B − ΣDᵢ = count·G`.
    pub fn publish(&mut self, counts: VecM<u64, MAX_OPTIONS>) {
        let poll = self.load();
        let mut state = self.require(Phase::Counted);
        let options = poll.paper.options.len();
        ensure(counts.len() == options, BallotError::WrongLength);
        let turnout: u128 = counts.iter().map(|&n| u128::from(n)).sum();
        ensure(
            turnout == self.turnout.get() as u128,
            BallotError::WrongCounts,
        );
        let trustees = poll.terms.trustees.len();
        let mut shares = [[IDENTITY; OPTIONS]; TRUSTEES];
        for (index, shares) in shares.iter_mut().enumerate().take(trustees) {
            let submitted = self
                .trustees
                .at(index as u32)
                .shares
                .try_get()
                .none_if_missing()
                .or_throw(BallotError::SharesMissing);
            shares[..options].copy_from_slice(&submitted);
        }
        let totals = self.totals.get();
        for (option, count) in counts.iter().enumerate() {
            let mut check = Sum::<{ TRUSTEES + 2 }>::new();
            check.add(&ONE, &totals[option].b);
            for shares in &shares[..trustees] {
                check.add(&MINUS_ONE, &shares[option]);
            }
            check.add(&neg(&from_u64(*count)), &G);
            ensure(check.eval() == Some(IDENTITY), BallotError::WrongCounts);
        }
        self.results.set_exclusive(&counts);
        state.phase = Phase::Published;
        self.state.set_exclusive(&state);
        log_event(&Published { counts });
    }

    /// Give up on a poll that cannot finish. Anyone may call it:
    ///
    /// - if the poll is still in setup at the close: it never opened. Every trustee can reclaim
    ///   its bond.
    /// - if the trustees' window has passed with some trustee's shares missing. The trustees
    ///   who decrypted can reclaim their bonds; the rest stay in this contract for good.
    ///
    /// The count cannot fail: anyone can finish it. A poll whose shares are all in cannot fail
    /// either, since anyone can publish it.
    pub fn fail(&mut self) {
        let terms = self.load().terms;
        let mut state = self.state.get();
        let deadline = match state.phase {
            Phase::Setup => terms.close,
            Phase::Counted => state.counted_at.saturating_add(terms.decrypt_window),
            _ => throw(BallotError::WrongPhase),
        };
        ensure(Self::now() >= deadline, BallotError::TooEarly);
        let mut forfeited = Vec::new();
        if state.phase == Phase::Counted {
            for (index, trustee) in terms.trustees.iter().enumerate() {
                let shares = self.trustees.at(index as u32).shares.try_get();
                if shares.none_if_missing().is_none() {
                    forfeited.push(*trustee);
                }
            }
            ensure(!forfeited.is_empty(), BallotError::SharesComplete);
        }
        state.phase = Phase::Failed;
        self.state.set_exclusive(&state);
        log_event(&Failed {
            forfeited: VecM(forfeited),
        });
    }

    /// Take the caller's bond back: once the results are out, or once the poll has failed,
    /// unless it failed for want of the caller's shares. Trustees only, once each.
    pub fn reclaim(&mut self) {
        let terms = self.load().terms;
        let state = self.state.get();
        let trustee = get_caller();
        let mut slot = self.trustees.at_mut(Self::trustee_index(&terms, &trustee));
        let decrypted = slot.shares.try_get().none_if_missing().is_some();
        // A poll that failed in setup never counted: nobody could have decrypted.
        let kept = match state.phase {
            Phase::Published => true,
            Phase::Failed => state.counted_at == 0 || decrypted,
            _ => false,
        };
        let bonded = slot.bonded.try_get().none_if_missing().is_some();
        ensure(kept && bonded, BallotError::NoBond);
        // The exclusive delete is what makes a bond come back once: two reclaims in one block
        // cannot both commit, and in a later block the bond is gone.
        slot.bonded.delete_exclusive();
        ERC20Client::new(&terms.bond_token).transfer(&trustee, terms.bond);
    }

    pub fn poll(&self) -> Poll {
        self.load()
    }

    pub fn state(&self) -> State {
        self.state.get()
    }

    /// How many voters are on the roll.
    pub fn electorate(&self) -> i128 {
        self.electorate.get()
    }

    /// How many ballots have been cast, as of this block's start.
    pub fn turnout(&self) -> i128 {
        self.turnout.get()
    }

    /// Whether `voter` has voted, or `None` if it is not on the roll.
    pub fn has_voted(&self, voter: &ContractAddress) -> Option<bool> {
        self.roll.at(voter).try_get().none_if_missing()
    }

    /// The trustee's key, once it has submitted one.
    pub fn trustee_key(&self, index: u32) -> Option<Point> {
        ensure(index < MAX_TRUSTEES, BallotError::NotTrustee);
        self.trustees.at(index).key.try_get().none_if_missing()
    }

    /// The trustee's shares, once it has decrypted.
    pub fn trustee_shares(&self, index: u32) -> Option<VecM<Point, MAX_OPTIONS>> {
        ensure(index < MAX_TRUSTEES, BallotError::NotTrustee);
        self.trustees.at(index).shares.try_get().none_if_missing()
    }

    /// How many of a station's ballots have been counted, and their total so far.
    pub fn station(&self, station: u32) -> (u64, Ciphertexts) {
        ensure(station < STATIONS, BallotError::NoSuchStation);
        let station = self.stations.at(station);
        (station.counted.get(), station.total.get())
    }

    /// Every ballot added up, once the count has finished.
    pub fn totals(&self) -> Option<Ciphertexts> {
        self.totals.try_get().none_if_missing()
    }

    /// How many ballots chose each option, once published.
    pub fn results(&self) -> Option<VecM<u64, MAX_OPTIONS>> {
        self.results.try_get().none_if_missing()
    }
}
