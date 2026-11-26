//! The voters' and trustees' side of a poll, in native Rust with `curve25519-dalek`: what a wallet
//! would do off chain. The contract only checks what these functions make.

// Each test crate uses its own subset of these.
#![allow(dead_code)]

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;
use secret_ballot::group::Point;
use secret_ballot::proofs::{BitProof, Ciphertext, Proof};
use secret_ballot::{Ballot, Choice, Share};
use sha2::{Digest, Sha256, Sha512};
use thruput_sdk::{ContractAddress, VecM};

/// Deterministic randomness, so that a failing test fails the same way every time. A wallet would
/// use its operating system's.
pub struct Rng {
    seed: [u8; 32],
    drawn: u64,
}

impl Rng {
    pub fn new(label: &str) -> Self {
        Self {
            seed: Sha256::digest(label.as_bytes()).into(),
            drawn: 0,
        }
    }

    pub fn scalar(&mut self) -> Scalar {
        self.drawn += 1;
        let mut wide = Sha512::new();
        wide.update(self.seed);
        wide.update(self.drawn.to_le_bytes());
        Scalar::from_bytes_mod_order_wide(&wide.finalize().into())
    }
}

pub fn encode(point: &RistrettoPoint) -> Point {
    point.compress().to_bytes()
}

pub fn decode(point: &Point) -> RistrettoPoint {
    CompressedRistretto(*point)
        .decompress()
        .expect("a valid point")
}

/// The contract's transcript, byte for byte: the kind of proof, the poll's address, whom the proof
/// is for, then the statement and commitments.
struct Transcript(Sha256);

impl Transcript {
    fn new(kind: &[u8], poll: &ContractAddress, who: &ContractAddress) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(kind);
        hasher.update(poll.into_inner());
        hasher.update(who.into_inner());
        Self(hasher)
    }

    fn point(mut self, point: &RistrettoPoint) -> Self {
        self.0.update(encode(point));
        self
    }

    fn index(mut self, index: usize) -> Self {
        self.0.update((index as u32).to_le_bytes());
        self
    }

    fn challenge(self) -> Scalar {
        let mut c: [u8; 32] = self.0.finalize().into();
        c[31] &= 0x0f;
        Scalar::from_canonical_bytes(c).expect("below 2^252")
    }
}

fn proof(c: Scalar, s: Scalar) -> Proof {
    Proof {
        c: c.to_bytes(),
        s: s.to_bytes(),
    }
}

/// A trustee's secret key share `x`, and the public `x·G`.
pub struct KeyShare {
    pub secret: Scalar,
    pub public: Point,
}

impl KeyShare {
    pub fn new(rng: &mut Rng) -> Self {
        let secret = rng.scalar();
        Self {
            secret,
            public: encode(&(secret * G)),
        }
    }

    /// A Schnorr proof that `trustee` knows `x`: commit to `w·G`, and answer the challenge with
    /// `s = w + c·x`.
    pub fn prove(&self, rng: &mut Rng, poll: &ContractAddress, trustee: &ContractAddress) -> Proof {
        let w = rng.scalar();
        let c = Transcript::new(b"secret-ballot:key", poll, trustee)
            .point(&decode(&self.public))
            .point(&(w * G))
            .challenge();
        proof(c, w + c * self.secret)
    }

    /// This trustee's share of decrypting each option's total: `x·A`, and a proof that the same
    /// `x` is behind its key (a Chaum–Pedersen proof).
    pub fn decrypt(
        &self,
        rng: &mut Rng,
        poll: &ContractAddress,
        trustee: &ContractAddress,
        totals: &[Ciphertext],
    ) -> VecM<Share, { secret_ballot::MAX_OPTIONS }> {
        let key = decode(&self.public);
        let shares = totals
            .iter()
            .enumerate()
            .map(|(option, total)| {
                let a = decode(&total.a);
                let share = self.secret * a;
                let w = rng.scalar();
                let c = Transcript::new(b"secret-ballot:share", poll, trustee)
                    .index(option)
                    .point(&key)
                    .point(&a)
                    .point(&share)
                    .point(&(w * G))
                    .point(&(w * a))
                    .challenge();
                Share {
                    share: encode(&share),
                    proof: proof(c, w + c * self.secret),
                }
            })
            .collect();
        VecM(shares)
    }
}

/// The poll's key: the sum of the trustees' keys.
pub fn poll_key(trustees: &[KeyShare]) -> Point {
    encode(&trustees.iter().map(|t| decode(&t.public)).sum())
}

/// A ballot for option `choice` of `options`, for `voter` in `poll`, under the poll's `key`.
pub fn ballot(
    rng: &mut Rng,
    poll: &ContractAddress,
    voter: &ContractAddress,
    key: &Point,
    options: usize,
    choice: usize,
) -> Ballot {
    let votes: Vec<i64> = (0..options).map(|o| i64::from(o == choice)).collect();
    ballot_of(rng, poll, voter, key, &votes)
}

/// A ballot that encrypts `votes`, one number an option, with each proof made as an honest
/// voter's would be. Unless each vote is a 0 or a 1 and they add up to 1, some proof is made for
/// a statement that is false, and the contract refuses the ballot.
pub fn ballot_of(
    rng: &mut Rng,
    poll: &ContractAddress,
    voter: &ContractAddress,
    key: &Point,
    votes: &[i64],
) -> Ballot {
    let y = decode(key);
    let mut choices = Vec::new();
    let mut randomness = Scalar::ZERO;
    for (option, &vote) in votes.iter().enumerate() {
        let r = rng.scalar();
        randomness += r;
        let m = match vote {
            0.. => Scalar::from(vote as u64),
            _ => -Scalar::from(vote.unsigned_abs()),
        };
        let (a, b) = (r * G, m * G + r * y);
        choices.push(Choice {
            ciphertext: Ciphertext {
                a: encode(&a),
                b: encode(&b),
            },
            proof: bit_proof(
                rng,
                poll,
                voter,
                option,
                &y,
                (a, b),
                r,
                vote.clamp(0, 1) as u64,
            ),
        });
    }

    // The sum (A, B) is (R·G, G + R·Y): prove that log_G A = log_Y (B − G), knowing R.
    let w = rng.scalar();
    let mut t = Transcript::new(b"secret-ballot:one", poll, voter).point(&y);
    for choice in &choices {
        t = t
            .point(&decode(&choice.ciphertext.a))
            .point(&decode(&choice.ciphertext.b));
    }
    let c = t.point(&(w * G)).point(&(w * y)).challenge();
    Ballot {
        choices: VecM(choices),
        proof: proof(c, w + c * randomness),
    }
}

// A proof that `(a, b)` encrypts 0 or 1, by a voter who knows it encrypts `vote` with randomness
// `r`. The case that is false is simulated: pick its challenge and response first, and work back
// to the commitments they need. The true case is proved for real, with the challenge left over.
#[allow(clippy::too_many_arguments)]
fn bit_proof(
    rng: &mut Rng,
    poll: &ContractAddress,
    voter: &ContractAddress,
    option: usize,
    y: &RistrettoPoint,
    (a, b): (RistrettoPoint, RistrettoPoint),
    r: Scalar,
    vote: u64,
) -> BitProof {
    let real = vote as usize;
    let fake = 1 - real;
    let (mut c, mut s) = ([Scalar::ZERO; 2], [Scalar::ZERO; 2]);
    let mut commitments = [(RistrettoPoint::identity(), RistrettoPoint::identity()); 2];

    (c[fake], s[fake]) = (rng.scalar(), rng.scalar());
    let shifted = b - Scalar::from(fake as u64) * G;
    commitments[fake] = (s[fake] * G - c[fake] * a, s[fake] * y - c[fake] * shifted);

    let w = rng.scalar();
    commitments[real] = (w * G, w * y);

    let challenge = Transcript::new(b"secret-ballot:bit", poll, voter)
        .index(option)
        .point(y)
        .point(&a)
        .point(&b)
        .point(&commitments[0].0)
        .point(&commitments[0].1)
        .point(&commitments[1].0)
        .point(&commitments[1].1)
        .challenge();
    c[real] = challenge - c[fake];
    s[real] = w + c[real] * r;

    BitProof {
        c0: c[0].to_bytes(),
        s0: s[0].to_bytes(),
        c1: c[1].to_bytes(),
        s1: s[1].to_bytes(),
    }
}

/// What each option's total decrypts to, given every trustee's shares: `B − ΣDᵢ = n·G`, and `n`
/// is found by trying each count up to `most` in turn. Anyone can do this once the shares are
/// public; it needs no secret.
pub fn counts(totals: &[Ciphertext], shares: &[Vec<Point>], most: u64) -> Vec<u64> {
    totals
        .iter()
        .enumerate()
        .map(|(option, total)| {
            let target: RistrettoPoint = decode(&total.b)
                - shares
                    .iter()
                    .map(|s| decode(&s[option]))
                    .sum::<RistrettoPoint>();
            let mut guess = RistrettoPoint::identity();
            (0..=most)
                .find(|_| {
                    let found = guess == target;
                    guess += G;
                    found
                })
                .expect("a count no larger than the turnout")
        })
        .collect()
}
