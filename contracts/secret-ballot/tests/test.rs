mod prover;

use erc20::{ERC20Client, ERC20MetadataClient};
use prover::{KeyShare, Rng};
use secret_ballot::group::{self, Point};
use secret_ballot::proofs::Ciphertext;
use secret_ballot::*;
use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

// Blocks are a second apart from START. Voting closes an hour in, and the trustees have a day
// from the end of the count.
const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const CLOSE: u64 = START + 3_600 * SECOND;
const WINDOW: u64 = 86_400 * SECOND;

// What each trustee deposits, and starts with, in the bond token.
const BOND: i128 = 1_000;
const FUNDS: i128 = 1_000_000;

// The native tokens each party starts with when storage is priced.
const NATIVE: i128 = 100_000_000;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn names(prefix: &str, n: usize) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}-{i}")).collect()
}

fn paper(options: usize) -> Paper {
    Paper {
        question: "Where should the offsite be?".try_into().unwrap(),
        options: VecM(
            ["Lisbon", "Kyoto", "Oaxaca", "Tromsø"][..options]
                .iter()
                .map(|o| (*o).try_into().unwrap())
                .collect(),
        ),
    }
}

fn terms(trustees: usize, bond_token: ContractAddress) -> Terms {
    Terms {
        trustees: VecM(names("trustee", trustees).iter().map(|t| addr(t)).collect()),
        close: CLOSE,
        decrypt_window: WINDOW,
        bond_token,
        bond: BOND,
    }
}

// Whether storage is free, as in most of these tests, or priced as the network prices it, with
// `reserve` native tokens sent to the poll when it is deployed.
#[derive(Clone, Copy)]
enum Storage {
    Free,
    Priced { reserve: i128 },
}

// What storing one item costs, as the network prices it by default.
fn item() -> i128 {
    TestEnvironment::default()
        .get_current_cost_model()
        .nnint_cost()
}

struct Fixture {
    env: TestEnvironmentHandle,
    _codes: [MockContract; 2],
    poll: ContractAddress,
    // What the trustees' bonds are in.
    token: ContractAddress,
    options: usize,
    keys: Vec<KeyShare>,
    rng: RefCell<Rng>,
}

impl Fixture {
    // A poll with `options` options and `trustees` trustees, with `voters` on its roll, open for
    // voting. Returns in a block where the poll is open.
    fn open(options: usize, trustees: usize, voters: &[String]) -> Self {
        Self::setup(options, trustees, voters).opened()
    }

    // The same poll, still in setup: no trustee has submitted a key.
    fn setup(options: usize, trustees: usize, voters: &[String]) -> Self {
        Self::new(options, trustees, BOND, voters, Storage::Free)
    }

    // An open poll with storage priced, and `reserve` sent to the poll. No bonds.
    fn priced(options: usize, trustees: usize, voters: &[String], reserve: i128) -> Self {
        Self::new(options, trustees, 0, voters, Storage::Priced { reserve }).opened()
    }

    fn opened(self) -> Self {
        self.submit_keys(self.keys.len());
        self.call("admin", |c| c.open());
        self.env.advance_block();
        self
    }

    fn new(
        options: usize,
        trustees: usize,
        bond: i128,
        voters: &[String],
        storage: Storage,
    ) -> Self {
        let (env, reserve) = match storage {
            Storage::Free => (TestEnvironment::no_cost(), 0),
            Storage::Priced { reserve } => (TestEnvironment::default(), reserve),
        };
        let admin = addr("admin");
        let trustee_addrs: Vec<_> = names("trustee", trustees).iter().map(|t| addr(t)).collect();
        // The native token pays for its own storage, like any token.
        for who in trustee_addrs.iter().chain([&admin, &ADDRESS_NATIVE_TOKEN]) {
            env.setup_grant_storage_tokens(who, NATIVE as i64);
        }
        env.advance_block_at(START.into());
        env.set_block_time_step(Some(Duration::from_secs(1)));

        let code = register_mock_contract(&env);
        let token_code = erc20::register_mock_contract(&env);
        let native = ERC20Client::new(&ADDRESS_NATIVE_TOKEN);
        let (mut poll, mut token) = (admin, admin);
        env.transact(|tx| {
            tx.call(&admin).run(AssertUnwindSafe(|| {
                token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
                if reserve > 0 {
                    native.transfer(&token, NATIVE / 10);
                }
                ERC20MetadataClient::new(&token).initialize(&admin, None, None, Some(2));
                for trustee in &trustee_addrs {
                    ERC20Client::new(&token).mint(trustee, FUNDS);
                }

                // Deploy and start the poll in one transaction, so nobody can start it first.
                poll = deploy_contract(&sha256_static!("poll"), code.as_hash());
                if reserve > 0 {
                    native.transfer(&poll, reserve);
                }
                let terms = Terms {
                    bond,
                    ..terms(trustees, token)
                };
                SecretBallotClient::new(&poll).initialize(paper(options), terms);
            }))
        })
        .assert_success();
        env.advance_block();

        let mut rng = Rng::new("keys");
        let keys = trustee_addrs
            .iter()
            .map(|_| KeyShare::new(&mut rng))
            .collect();
        let f = Self {
            env,
            _codes: [code, token_code],
            poll,
            token,
            options,
            keys,
            rng: RefCell::new(Rng::new("ballots")),
        };
        for batch in voters.chunks(MAX_REGISTER as usize) {
            let batch = VecM(batch.iter().map(|v| addr(v)).collect());
            f.call("admin", |c| c.register(batch));
        }
        for trustee in &trustee_addrs {
            f.env
                .transact(|tx| {
                    tx.call(trustee)
                        .run(move || ERC20Client::new(&token).adjust_allowance(&poll, FUNDS))
                })
                .assert_success();
        }
        f.env.advance_block();
        f
    }

    // The first `n` trustees submit their keys.
    fn submit_keys(&self, n: usize) {
        for index in 0..n {
            let trustee = addr(&format!("trustee-{index}"));
            let key = &self.keys[index];
            let proof = key.prove(&mut self.rng.borrow_mut(), &self.poll, &trustee);
            self.call(&format!("trustee-{index}"), |c| {
                c.submit_key(key.public, proof)
            });
        }
        self.env.advance_block();
    }

    // Run `f` against the poll as `caller`, in the current block, and require it to succeed.
    fn call<R>(&self, caller: &str, f: impl FnOnce(SecretBallotClient) -> R) -> R
    where
        R: WriteXDR + xdr::ReadXDROwned,
    {
        let poll = self.poll;
        let result = self.env.transact(|tx| {
            tx.call(&addr(caller))
                .run(AssertUnwindSafe(|| f(SecretBallotClient::new(&poll))))
        });
        result.assert_success();
        result.assert_return_as::<R>()
    }

    // The error the call `f` makes fails with, as `caller`. `f` returns the call's error:
    // `|c| c.try_open().err()`.
    fn refused(
        &self,
        caller: &str,
        f: impl FnOnce(SecretBallotClient) -> Option<CallError>,
    ) -> BallotError {
        let poll = self.poll;
        let mut error = None;
        self.env
            .transact(|tx| {
                tx.call(&addr(caller)).run(AssertUnwindSafe(|| {
                    error = f(SecretBallotClient::new(&poll));
                }))
            })
            .assert_success();
        error
            .expect("the call succeeded")
            .try_as::<BallotError>()
            .expect("a ballot error")
    }

    fn key(&self) -> Point {
        self.call("viewer", |c| c.state()).key
    }

    // `voter`'s ballot for `choice`.
    fn ballot(&self, voter: &str, choice: usize) -> Ballot {
        let key = self.key();
        prover::ballot(
            &mut self.rng.borrow_mut(),
            &self.poll,
            &addr(voter),
            &key,
            self.options,
            choice,
        )
    }

    // `voter`'s ballot encrypting `votes`, whatever they are.
    fn ballot_of(&self, voter: &str, votes: &[i64]) -> Ballot {
        let key = self.key();
        prover::ballot_of(
            &mut self.rng.borrow_mut(),
            &self.poll,
            &addr(voter),
            &key,
            votes,
        )
    }

    fn vote(&self, voter: &str, station: u32, choice: usize) {
        let ballot = self.ballot(voter, choice);
        self.call(voter, |c| c.cast(station, ballot));
    }

    // Execute `voter`'s ballot in the current block without committing it.
    fn pending_cast(&self, voter: &str, station: u32, ballot: Ballot) -> MockTransactionHandler {
        let poll = self.poll;
        let mut tx = self.env.transaction().build();
        tx.call(&addr(voter))
            .run(move || SecretBallotClient::new(&poll).cast(station, ballot))
            .assert_success();
        tx
    }

    fn pending_count(&self, station: u32) -> MockTransactionHandler {
        let poll = self.poll;
        let mut tx = self.env.transaction().build();
        tx.call(&addr("counter"))
            .run(move || SecretBallotClient::new(&poll).count(station))
            .assert_success();
        tx
    }

    // Count every station's box dry, all stations in each block, and return how many ballots
    // that took. Leaves the next block open.
    fn count_all(&self) -> u64 {
        let mut counted = 0;
        loop {
            let taken: u32 = (0..STATIONS)
                .map(|s| self.call("counter", |c| c.count(s)))
                .sum();
            self.env.advance_block();
            if taken == 0 {
                return counted;
            }
            counted += u64::from(taken);
        }
    }

    // Move to the first block at or after the close.
    fn close(&self) {
        self.env.advance_block_at(CLOSE.into());
    }

    // Close the poll, count it, and finish the count, visible from the next block.
    fn close_and_count(&self) {
        self.close();
        self.count_all();
        self.call("anyone", |c| c.finish_count());
        self.env.advance_block();
    }

    fn totals(&self) -> Vec<Ciphertext> {
        let totals = self.call("viewer", |c| c.totals()).expect("counted");
        totals[..self.options].to_vec()
    }

    // Trustee `index`'s shares of the totals, made honestly.
    fn shares(&self, index: usize) -> VecM<Share, MAX_OPTIONS> {
        let trustee = addr(&format!("trustee-{index}"));
        self.keys[index].decrypt(
            &mut self.rng.borrow_mut(),
            &self.poll,
            &trustee,
            &self.totals(),
        )
    }

    fn decrypt(&self, index: usize) {
        let shares = self.shares(index);
        self.call(&format!("trustee-{index}"), |c| c.decrypt(shares));
    }

    // What the totals decrypt to, from the shares on chain: what anyone can work out.
    fn counts(&self) -> Vec<u64> {
        let shares: Vec<Vec<Point>> = (0..self.keys.len() as u32)
            .map(|i| {
                let shares = self.call("viewer", |c| c.trustee_shares(i));
                shares.expect("decrypted").0
            })
            .collect();
        let turnout = self.call("viewer", |c| c.turnout()) as u64;
        prover::counts(&self.totals(), &shares, turnout)
    }

    // Every trustee decrypts, and anyone publishes what the totals come to.
    fn decrypt_and_publish(&self) -> Vec<u64> {
        for index in 0..self.keys.len() {
            self.decrypt(index);
        }
        self.env.advance_block();
        let counts = self.counts();
        let published = VecM(counts.clone());
        self.call("anyone", |c| c.publish(published));
        self.env.advance_block();
        counts
    }

    fn phase(&self) -> Phase {
        self.call("viewer", |c| c.state()).phase
    }

    fn balance_in(&self, token: ContractAddress, holder: ContractAddress) -> i128 {
        let r = self.env.transact(|tx| {
            tx.call(&addr("viewer"))
                .run(move || ERC20Client::new(&token).get_balance_of(&holder))
        });
        r.assert_success();
        r.assert_return_as::<i128>()
    }

    fn native(&self, holder: &ContractAddress) -> i128 {
        self.balance_in(ADDRESS_NATIVE_TOKEN, *holder)
    }

    // What each trustee holds of the bond token.
    fn trustee_balances(&self) -> Vec<i128> {
        (0..self.keys.len())
            .map(|i| self.balance_in(self.token, addr(&format!("trustee-{i}"))))
            .collect()
    }

    // Every trustee that can reclaims its bond.
    fn reclaim_all(&self) {
        for index in 0..self.keys.len() {
            let poll = self.poll;
            let trustee = addr(&format!("trustee-{index}"));
            self.env
                .transact(|tx| {
                    tx.call(&trustee)
                        .run(move || SecretBallotClient::new(&poll).try_reclaim().is_ok())
                })
                .assert_success();
        }
        self.env.advance_block();
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

fn admitted(results: &[TryCommitResult]) -> usize {
    results
        .iter()
        .filter(|r| **r == TryCommitResult::Ok)
        .count()
}

// Six voters choose among three places. Nobody can read a ballot, the count adds them up without
// reading them, and the trustees decrypt only the totals. Each trustee's bond goes back.
#[test]
fn a_poll_counts_ballots_that_nobody_can_read() {
    let voters = names("voter", 6);
    let f = Fixture::open(3, 3, &voters);
    assert_eq!(f.call("viewer", |c| c.electorate()), 6);
    assert_eq!(f.trustee_balances(), vec![FUNDS - BOND; 3]);

    // The poll's key is the sum of the trustees' keys: no one of them holds it.
    assert_eq!(f.key(), prover::poll_key(&f.keys));

    let choices = [0, 1, 1, 2, 1, 0];
    for (i, (voter, choice)) in voters.iter().zip(choices).enumerate() {
        f.vote(voter, i as u32 % STATIONS, choice);
    }
    f.env.advance_block();
    assert_eq!(f.call("viewer", |c| c.turnout()), 6);
    assert_eq!(
        f.call("viewer", |c| c.has_voted(&addr("voter-0"))),
        Some(true)
    );
    assert_eq!(f.call("viewer", |c| c.has_voted(&addr("stranger"))), None);

    // Two ballots for the same option look nothing alike: each is encrypted with fresh
    // randomness.
    let (a, b) = (f.ballot("voter-0", 1), f.ballot("voter-0", 1));
    assert_ne!(a.choices[1].ciphertext, b.choices[1].ciphertext);

    f.close_and_count();
    assert_eq!(f.phase(), Phase::Counted);
    assert_eq!(f.decrypt_and_publish(), vec![2, 3, 1]);
    assert_eq!(f.phase(), Phase::Published);
    assert_eq!(f.call("viewer", |c| c.results()), Some(VecM(vec![2, 3, 1])));
    f.reclaim_all();
    assert_eq!(f.trustee_balances(), vec![FUNDS; 3]);
}

// A crowd votes in one block, and no ballot conflicts with another. A box takes 250 ballots a
// block: the rest are left out of the block at commit, with nothing written, and land at another
// station. A count takes at most a batch, so a box with more waits for the next block.
#[test]
fn a_crowd_votes_in_one_block() {
    let voters = names("voter", 260);
    let f = Fixture::open(2, 1, &voters);
    let ballots: Vec<_> = voters.iter().map(|v| f.ballot(v, 0)).collect();
    let txs = voters
        .iter()
        .zip(ballots.clone())
        .map(|(voter, ballot)| f.pending_cast(voter, 0, ballot))
        .collect();
    let results = commit_all(txs);
    assert_eq!(admitted(&results), 250);
    assert!(
        results[250..]
            .iter()
            .all(|r| matches!(r, TryCommitResult::TxNonDeterministicError(_)))
    );

    // The voters left out are still free to vote. The same ballots land at another station, or
    // at the same one in the next block.
    let late: Vec<_> = voters.iter().zip(ballots).skip(250).collect();
    for (voter, ballot) in &late[..5] {
        f.call(voter, |c| c.cast(1, ballot.clone()));
    }
    f.env.advance_block();
    for (voter, ballot) in &late[5..] {
        f.call(voter, |c| c.cast(0, ballot.clone()));
    }
    f.env.advance_block();
    assert_eq!(f.call("viewer", |c| c.turnout()), 260);

    // Station 0's box now holds more than one count takes: the rest wait for the next block.
    f.close();
    assert_eq!(f.call("counter", |c| c.count(0)), COUNT_BATCH);
    assert_eq!(f.call("counter", |c| c.count(1)), 5);
    f.env.advance_block();
    assert_eq!(f.call("counter", |c| c.count(0)), 5);
    f.env.advance_block();
    f.call("anyone", |c| c.finish_count());
    f.env.advance_block();
    assert_eq!(f.decrypt_and_publish(), vec![260, 0]);
}

// One count a station commits in a block, since it takes from the station's box. Counts at
// different stations never conflict, so all eight stations count in one block.
#[test]
fn the_stations_count_in_parallel() {
    let voters = names("voter", 2 * STATIONS as usize);
    let f = Fixture::open(2, 1, &voters);
    for (i, voter) in voters.iter().enumerate() {
        f.vote(voter, i as u32 % STATIONS, i % 2);
    }
    f.env.advance_block();

    let mut txs: Vec<_> = (0..STATIONS).map(|s| f.pending_count(s)).collect();
    txs.push(f.pending_count(0));
    let results = commit_all(txs);
    assert_eq!(admitted(&results[..STATIONS as usize]), STATIONS as usize);
    assert!(matches!(
        results[STATIONS as usize],
        TryCommitResult::TxNonDeterministicError(_)
    ));
    f.env.advance_block();
    for station in 0..STATIONS {
        assert_eq!(f.call("viewer", |c| c.station(station)).0, 2);
    }
    f.close_and_count();
    assert_eq!(f.decrypt_and_publish(), vec![STATIONS as u64; 2]);
}

// A ballot's proofs are what stop it from counting more than once. Each choice must encrypt a 0
// or a 1, and they must add up to 1.
#[test]
fn a_ballot_must_choose_exactly_one_option() {
    let voters = names("voter", 1);
    let f = Fixture::open(3, 2, &voters);
    let cast = |ballot: Ballot| f.refused("voter-0", |c| c.try_cast(0, ballot).err());

    // Two options, or none.
    assert_eq!(
        cast(f.ballot_of("voter-0", &[1, 1, 0])),
        BallotError::InvalidProof
    );
    assert_eq!(
        cast(f.ballot_of("voter-0", &[0, 0, 0])),
        BallotError::InvalidProof
    );
    // Two votes for one option and minus one for another add up to one. Only the proofs that
    // each is a 0 or a 1 refuse it.
    assert_eq!(
        cast(f.ballot_of("voter-0", &[2, -1, 0])),
        BallotError::InvalidProof
    );

    // A ballot's parts cannot be moved around, or left out.
    let mut swapped = f.ballot("voter-0", 0);
    let mut choices = swapped.choices.0.clone();
    choices.swap(0, 1);
    swapped.choices = VecM(choices);
    assert_eq!(cast(swapped), BallotError::InvalidProof);
    let mut short = f.ballot("voter-0", 0);
    short.choices = VecM(short.choices[..2].to_vec());
    assert_eq!(cast(short), BallotError::WrongLength);
    let mut bad = f.ballot("voter-0", 0);
    bad.choices.0[2].ciphertext.b = [0xff; 32];
    assert_eq!(cast(bad), BallotError::InvalidProof);

    // None of that cost the voter its vote.
    f.vote("voter-0", 0, 2);
}

// Every proof is bound to the voter it was made for. A ballot copied from someone else's
// transaction is refused, so nobody can vote the same way as a voter without knowing how.
#[test]
fn a_copied_ballot_is_refused() {
    let voters = names("voter", 2);
    let f = Fixture::open(2, 2, &voters);
    let alices = f.ballot("voter-0", 1);
    let copy = alices.clone();
    assert_eq!(
        f.refused("voter-1", |c| c.try_cast(0, copy).err()),
        BallotError::InvalidProof
    );
    f.call("voter-0", |c| c.cast(0, alices));
}

// A voter votes once. Two ballots from one voter in a block cannot both commit, and a ballot in a
// later block is refused. Nobody off the roll can vote at all.
#[test]
fn each_voter_votes_once() {
    let voters = names("voter", 1);
    let f = Fixture::open(2, 1, &voters);
    let txs = vec![
        f.pending_cast("voter-0", 0, f.ballot("voter-0", 0)),
        f.pending_cast("voter-0", 1, f.ballot("voter-0", 1)),
    ];
    let results = commit_all(txs);
    assert_eq!(results[0], TryCommitResult::Ok);
    assert!(matches!(
        results[1],
        TryCommitResult::TxNonDeterministicError(_)
    ));
    f.env.advance_block();
    assert_eq!(f.call("viewer", |c| c.turnout()), 1);

    let again = f.ballot("voter-0", 1);
    assert_eq!(
        f.refused("voter-0", |c| c.try_cast(2, again).err()),
        BallotError::AlreadyVoted
    );
    let stranger = f.ballot("stranger", 0);
    assert_eq!(
        f.refused("stranger", |c| c.try_cast(0, stranger).err()),
        BallotError::NotRegistered
    );
}

// A trustee proves it knows the secret behind its key. Otherwise the last trustee could submit a
// key that cancels the others' out, and decrypt every ballot alone.
#[test]
fn a_trustee_must_know_its_key() {
    let f = Fixture::setup(2, 2, &[]);
    f.submit_keys(1);
    let (first, second) = (addr("trustee-0"), addr("trustee-1"));

    // The rogue key `x·G − X₀` makes the poll's key `x·G`. Its submitter knows `x`, but not the
    // secret behind the key it submits, so it cannot prove it.
    let mut rng = Rng::new("rogue");
    let x = KeyShare::new(&mut rng);
    let rogue = prover::encode(&(prover::decode(&x.public) - prover::decode(&f.keys[0].public)));
    let proof = x.prove(&mut rng, &f.poll, &second);
    assert_eq!(
        f.refused("trustee-1", |c| c.try_submit_key(rogue, proof).err()),
        BallotError::InvalidProof
    );
    // A proof copied from the first trustee is no proof for the second.
    let copied = f.keys[0].prove(&mut rng, &f.poll, &first);
    let key = f.keys[0].public;
    assert_eq!(
        f.refused("trustee-1", |c| c.try_submit_key(key, copied).err()),
        BallotError::InvalidProof
    );
    // The identity would add nothing to the poll's key.
    assert_eq!(
        f.refused("trustee-1", |c| c
            .try_submit_key(group::IDENTITY, Default::default())
            .err()),
        BallotError::InvalidProof
    );
    // Nor can anyone else submit a key, or a trustee submit twice.
    let proof = f.keys[1].prove(&mut rng, &f.poll, &addr("admin"));
    let key = f.keys[1].public;
    assert_eq!(
        f.refused("admin", |c| c.try_submit_key(key, proof).err()),
        BallotError::NotTrustee
    );
    let proof = f.keys[0].prove(&mut rng, &f.poll, &first);
    let key = f.keys[0].public;
    assert_eq!(
        f.refused("trustee-0", |c| c.try_submit_key(key, proof).err()),
        BallotError::AlreadySubmitted
    );

    // The poll opens once every trustee has a key in.
    assert_eq!(
        f.refused("admin", |c| c.try_open().err()),
        BallotError::KeysMissing
    );
    let proof = f.keys[1].prove(&mut rng, &f.poll, &second);
    let key = f.keys[1].public;
    f.call("trustee-1", |c| c.submit_key(key, proof));
    f.env.advance_block();
    f.call("admin", |c| c.open());
}

// Anyone can count, while voting is still going on: a running total can only be read with every
// trustee's share. The count cannot finish until the poll has closed and every box is empty.
#[test]
fn anyone_can_count_while_voting_goes_on() {
    let voters = names("voter", 30);
    let f = Fixture::open(2, 2, &voters);
    for voter in &voters[..20] {
        f.vote(voter, 3, 1);
    }
    f.env.advance_block();
    assert_eq!(f.call("passer-by", |c| c.count(3)), 20);
    // A count of an empty box does nothing, and writes nothing.
    assert_eq!(f.call("passer-by", |c| c.count(4)), 0);
    assert_eq!(
        f.refused("passer-by", |c| c.try_count(STATIONS).err()),
        BallotError::NoSuchStation
    );
    f.env.advance_block();
    assert_eq!(f.call("viewer", |c| c.station(3)).0, 20);

    for voter in &voters[20..] {
        f.vote(voter, 4, 0);
    }
    assert_eq!(
        f.refused("anyone", |c| c.try_finish_count().err()),
        BallotError::VotingOpen
    );
    f.close();
    let late = f.ballot("voter-0", 0);
    assert_eq!(
        f.refused("voter-0", |c| c.try_cast(0, late).err()),
        BallotError::VotingClosed
    );
    assert_eq!(
        f.refused("anyone", |c| c.try_finish_count().err()),
        BallotError::StillCounting
    );
    assert_eq!(f.count_all(), 10);
    f.call("anyone", |c| c.finish_count());
    f.env.advance_block();
    assert_eq!(f.decrypt_and_publish(), vec![10, 20]);
}

// A trustee's share comes with a proof that it used the secret behind its key. A share made with
// any other secret is refused, so no trustee can skew the result by decrypting dishonestly.
#[test]
fn a_trustee_must_decrypt_honestly() {
    let voters = names("voter", 3);
    let f = Fixture::open(2, 2, &voters);
    for voter in &voters {
        f.vote(voter, 0, 1);
    }
    f.env.advance_block();
    assert_eq!(
        f.refused("trustee-0", |c| c.try_decrypt(VecM(vec![])).err()),
        BallotError::WrongPhase
    );
    f.close_and_count();

    // A share by another key, under the first trustee's name.
    let mut rng = Rng::new("liar");
    let liar = KeyShare::new(&mut rng);
    let lie = liar.decrypt(&mut rng, &f.poll, &addr("trustee-0"), &f.totals());
    assert_eq!(
        f.refused("trustee-0", |c| c.try_decrypt(lie).err()),
        BallotError::InvalidProof
    );
    // An honest share, sent by somebody else.
    let shares = f.shares(0);
    let stolen = shares.clone();
    assert_eq!(
        f.refused("trustee-1", |c| c.try_decrypt(stolen).err()),
        BallotError::InvalidProof
    );
    let short = VecM(shares[..1].to_vec());
    assert_eq!(
        f.refused("trustee-0", |c| c.try_decrypt(short).err()),
        BallotError::WrongLength
    );
    f.call("trustee-0", |c| c.decrypt(shares));
    f.env.advance_block();
    let again = f.shares(0);
    assert_eq!(
        f.refused("trustee-0", |c| c.try_decrypt(again).err()),
        BallotError::AlreadySubmitted
    );
    let outsider = f.shares(1);
    assert_eq!(
        f.refused("outsider", |c| c.try_decrypt(outsider).err()),
        BallotError::NotTrustee
    );
}

// Anyone may publish, but only the counts that the totals decrypt to.
#[test]
fn only_the_true_counts_can_be_published() {
    let voters = names("voter", 5);
    let f = Fixture::open(2, 2, &voters);
    for (i, voter) in voters.iter().enumerate() {
        f.vote(voter, 0, usize::from(i < 2));
    }
    f.close_and_count();
    f.decrypt(0);
    f.env.advance_block();
    assert_eq!(
        f.refused("anyone", |c| c.try_publish(VecM(vec![3, 2])).err()),
        BallotError::SharesMissing
    );
    f.decrypt(1);
    f.env.advance_block();
    assert_eq!(f.counts(), vec![3, 2]);
    // The same turnout, split the other way; and the wrong turnout.
    assert_eq!(
        f.refused("anyone", |c| c.try_publish(VecM(vec![2, 3])).err()),
        BallotError::WrongCounts
    );
    assert_eq!(
        f.refused("anyone", |c| c.try_publish(VecM(vec![3, 3])).err()),
        BallotError::WrongCounts
    );
    f.call("anyone", |c| c.publish(VecM(vec![3, 2])));
    f.env.advance_block();
    // Once published, a poll cannot fail.
    assert_eq!(
        f.refused("anyone", |c| c.try_fail().err()),
        BallotError::WrongPhase
    );
}

// A trustee who never decrypts holds up the result, which the last one to decrypt could see
// coming. Its bond is what that costs it: once the window is over, anyone can fail the poll, the
// trustees who decrypted get their bonds back, and the one who did not loses its own.
#[test]
fn a_trustee_who_withholds_its_share_loses_its_bond() {
    let voters = names("voter", 4);
    let f = Fixture::open(2, 3, &voters);
    for voter in &voters {
        f.vote(voter, 0, 0);
    }
    f.close_and_count();
    let counted_at = f.call("viewer", |c| c.state()).counted_at;
    f.decrypt(0);
    f.decrypt(2);
    f.env.advance_block();
    assert_eq!(
        f.refused("anyone", |c| c.try_fail().err()),
        BallotError::TooEarly
    );

    f.env.advance_block_at((counted_at + WINDOW).into());
    let late = f.shares(1);
    assert_eq!(
        f.refused("trustee-1", |c| c.try_decrypt(late).err()),
        BallotError::WindowClosed
    );
    assert_eq!(
        f.refused("trustee-0", |c| c.try_reclaim().err()),
        BallotError::NoBond
    );
    f.call("anyone", |c| c.fail());
    f.env.advance_block();
    assert_eq!(f.phase(), Phase::Failed);
    f.reclaim_all();
    assert_eq!(f.trustee_balances(), vec![FUNDS, FUNDS - BOND, FUNDS]);
    assert_eq!(f.balance_in(f.token, f.poll), BOND);
    assert_eq!(
        f.refused("trustee-1", |c| c.try_reclaim().err()),
        BallotError::NoBond
    );
    assert_eq!(
        f.refused("trustee-0", |c| c.try_reclaim().err()),
        BallotError::NoBond
    );
    assert_eq!(
        f.refused("anyone", |c| c.try_publish(VecM(vec![4, 0])).err()),
        BallotError::WrongPhase
    );
}

// A poll whose shares are all in cannot fail, however late it is: anyone can publish it.
#[test]
fn a_poll_with_every_share_cannot_fail() {
    let voters = names("voter", 1);
    let f = Fixture::open(2, 2, &voters);
    f.vote("voter-0", 0, 1);
    f.close_and_count();
    f.decrypt(0);
    f.decrypt(1);
    let counted_at = f.call("viewer", |c| c.state()).counted_at;
    f.env.advance_block_at((counted_at + WINDOW).into());
    assert_eq!(
        f.refused("anyone", |c| c.try_fail().err()),
        BallotError::SharesComplete
    );
    f.call("anyone", |c| c.publish(VecM(vec![0, 1])));
}

// A poll that never opens gives back every bond, once its close has passed.
#[test]
fn a_poll_that_never_opens_gives_the_bonds_back() {
    let f = Fixture::setup(2, 3, &names("voter", 2));
    f.submit_keys(2);
    assert_eq!(
        f.refused("anyone", |c| c.try_fail().err()),
        BallotError::TooEarly
    );
    f.close();
    assert_eq!(
        f.refused("admin", |c| c.try_open().err()),
        BallotError::VotingClosed
    );
    f.call("anyone", |c| c.fail());
    f.env.advance_block();
    assert_eq!(f.phase(), Phase::Failed);
    f.reclaim_all();
    assert_eq!(f.trustee_balances(), vec![FUNDS; 3]);
    assert_eq!(f.balance_in(f.token, f.poll), 0);
}

// Nobody voted: the totals are encryptions of zero, and they decrypt to zero.
#[test]
fn a_poll_nobody_votes_in_publishes_zeroes() {
    let f = Fixture::open(3, 2, &names("voter", 3));
    f.close_and_count();
    assert_eq!(f.decrypt_and_publish(), vec![0, 0, 0]);
}

// Under the network's default storage prices, a voter on the roll costs the poll an item. A
// ballot costs it 8 base units, held in its station's box until it is counted. But until its block
// closes, each ballot's entry holds a deposit of an item more, out of the poll's native tokens. So
// what the poll holds beyond its storage, its float, is how many ballots one block can take. The
// rest are left out at commit, with nothing written, and land in a later block, when the deposits
// have come back.
#[test]
fn the_polls_float_sets_how_many_ballots_a_block_takes() {
    let (item, entry) = (item(), 8);
    let voters = names("voter", 12);

    // What the poll spends on its own storage, its roll, and the trustees' keys.
    let reserve = 10_000_000;
    let f = Fixture::priced(2, 1, &voters, reserve);
    let spent = reserve - f.native(&f.poll);
    assert!(spent > 12 * item);

    // A poll that holds that, and a float for five ballots and a bit.
    let float = 5 * (item + entry) + 100;
    let f = Fixture::priced(2, 1, &voters, spent + float);
    assert_eq!(f.native(&f.poll), float);
    let ballots: Vec<_> = voters.iter().map(|v| (v, f.ballot(v, 0))).collect();
    let mut waiting = ballots.as_slice();
    // When the first block closes, the box keeps an item for itself, and 8 for each ballot, out
    // of the float. What is left takes four ballots, and the last three fit after that.
    for expected in [5, 4, 3] {
        let txs = waiting
            .iter()
            .map(|(voter, ballot)| f.pending_cast(voter, 0, ballot.clone()))
            .collect();
        let results = commit_all(txs);
        assert_eq!(admitted(&results), expected);
        // They commit in order, so the ones that landed are the first.
        assert!(
            results[..expected]
                .iter()
                .all(|r| *r == TryCommitResult::Ok)
        );
        waiting = &waiting[expected..];
        f.env.advance_block();
    }
    assert!(waiting.is_empty());
    assert_eq!(f.native(&f.poll), float - item - 12 * entry);

    // Counting empties the box, which gives its deposits back.
    f.close();
    assert_eq!(f.call("counter", |c| c.count(0)), 12);
    f.env.advance_block();
    assert_eq!(f.native(&f.poll), float);
}

// Once the poll opens, its admin has no more say: the roll is frozen, and the poll runs to its
// close.
#[test]
fn the_admin_cannot_change_an_open_poll() {
    let f = Fixture::open(2, 1, &names("voter", 1));
    let late = VecM(vec![addr("sock-puppet")]);
    assert_eq!(
        f.refused("admin", |c| c.try_register(late).err()),
        BallotError::WrongPhase
    );
    assert_eq!(
        f.refused("admin", |c| c.try_open().err()),
        BallotError::WrongPhase
    );
    assert_eq!(
        f.refused("admin", |c| c.try_finish_count().err()),
        BallotError::VotingOpen
    );

    let g = Fixture::setup(2, 1, &[]);
    let voters = VecM(vec![addr("voter-0")]);
    assert_eq!(
        g.refused("voter-0", |c| c.try_register(voters).err()),
        BallotError::NotAdmin
    );
    g.submit_keys(1);
    assert_eq!(
        g.refused("trustee-0", |c| c.try_open().err()),
        BallotError::NotAdmin
    );
    // Registering a voter twice adds it once.
    let twice = VecM(vec![addr("voter-0"), addr("voter-0")]);
    assert_eq!(g.call("admin", |c| c.register(twice)), 1);
}

// A poll must ask something, offer 2 to 4 options, name 1 to 7 distinct trustees, and close in the
// future.
#[test]
fn bad_terms_are_refused() {
    let env = TestEnvironment::no_cost();
    env.advance_block_at(START.into());
    let code = register_mock_contract(&env);
    let mut blank = paper(2);
    blank.options.0[1] = " ".try_into().unwrap();
    let duplicate = VecM(vec![addr("t"), addr("t")]);
    let cases = [
        (paper(1), terms(1, addr("token"))),
        (blank, terms(1, addr("token"))),
        (paper(2), terms(0, addr("token"))),
        (
            paper(2),
            Terms {
                trustees: duplicate,
                ..terms(1, addr("token"))
            },
        ),
        (
            paper(2),
            Terms {
                close: START,
                ..terms(1, addr("token"))
            },
        ),
        (
            paper(2),
            Terms {
                decrypt_window: 0,
                ..terms(1, addr("token"))
            },
        ),
        (
            paper(2),
            Terms {
                bond: -1,
                ..terms(1, addr("token"))
            },
        ),
    ];
    for (i, (paper, terms)) in cases.into_iter().enumerate() {
        let r = env.transact(|tx| {
            tx.call(&addr("admin")).run(AssertUnwindSafe(|| {
                let poll = deploy_contract(&crypto::sha256(&[i as u8]), code.as_hash());
                SecretBallotClient::new(&poll)
                    .try_initialize(paper, terms)
                    .err()
                    .and_then(|e| e.try_as::<BallotError>())
            }))
        });
        r.assert_success();
        assert_eq!(
            r.assert_return_as::<Option<BallotError>>(),
            Some(BallotError::InvalidTerms),
            "case {i}"
        );
    }
    // Nor can the poll hold bonds in itself.
    let r = env.transact(|tx| {
        tx.call(&addr("admin")).run(AssertUnwindSafe(|| {
            let poll = deploy_contract(&sha256_static!("self"), code.as_hash());
            let terms = terms(1, poll);
            SecretBallotClient::new(&poll)
                .try_initialize(paper(2), terms)
                .err()
                .and_then(|e| e.try_as::<BallotError>())
        }))
    });
    assert_eq!(
        r.assert_return_as::<Option<BallotError>>(),
        Some(BallotError::InvalidTerms)
    );
}

// The contract's own scalar arithmetic, against curve25519-dalek's.
#[test]
fn the_group_constants_and_arithmetic_match_the_curve() {
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_COMPRESSED;
    use curve25519_dalek::scalar::Scalar;
    assert_eq!(group::G, RISTRETTO_BASEPOINT_COMPRESSED.to_bytes());
    assert_eq!(group::MINUS_ONE, (-Scalar::ONE).to_bytes());
    let mut rng = Rng::new("arithmetic");
    for _ in 0..100 {
        let (a, b) = (rng.scalar(), rng.scalar());
        assert_eq!(group::add(&a.to_bytes(), &b.to_bytes()), (a + b).to_bytes());
        assert_eq!(group::neg(&a.to_bytes()), (-a).to_bytes());
        assert!(group::is_reduced(&a.to_bytes()));
    }
    assert_eq!(group::neg(&[0; 32]), [0; 32]);
    let mut order = group::MINUS_ONE;
    order[0] += 1;
    assert!(!group::is_reduced(&order));
    assert!(group::is_reduced(&group::MINUS_ONE));
}
