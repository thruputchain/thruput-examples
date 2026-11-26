//! The four zero-knowledge proofs a poll checks, each a sigma protocol made non-interactive with
//! a Fiat–Shamir [`Transcript`].
//!
//! Notation: `G` is the generator and `Y` the poll's public key. A ciphertext `(a, b)` encrypts a
//! number `m` as `a = r·G` and `b = m·G + r·Y`, for a random `r` that only the voter knows. That is
//! ElGamal "in the exponent": adding ciphertexts adds what they encrypt, which is how the count
//! adds up ballots that nobody can read. Each check below recomputes the prover's commitments from
//! its responses, `R = s·G − c·X` and the like, and accepts if they hash back to its challenge.

use crate::OPTIONS;
use crate::group::*;
use thruput_sdk::*;

/// One encrypted number: `a = r·G`, `b = m·G + r·Y`.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub a: Point,
    pub b: Point,
}

/// A proof of knowledge of one secret: the challenge `c` and the response `s`.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Proof {
    pub c: Scalar,
    pub s: Scalar,
}

/// A proof that a ciphertext encrypts 0 or 1, without saying which: a proof for each case, one
/// real and one simulated, whose challenges must add up to the transcript's.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BitProof {
    pub c0: Scalar,
    pub s0: Scalar,
    pub c1: Scalar,
    pub s1: Scalar,
}

const KEY: &[u8] = b"secret-ballot:key";
const BIT: &[u8] = b"secret-ballot:bit";
const ONE_CHOICE: &[u8] = b"secret-ballot:one";
const SHARE: &[u8] = b"secret-ballot:share";

/// `trustee` knows the `x` with `key = x·G`.
///
/// Without this check, the last trustee to submit a key could submit `x·G` minus the others',
/// and the poll's key, their sum, would be `x·G`: one it alone could decrypt.
pub fn key_is_known(trustee: &ContractAddress, key: &Point, proof: &Proof) -> bool {
    // R = s·G − c·key
    let Some(r) = commitment(proof, &G, key) else {
        return false;
    };
    let mut t = Transcript::new(KEY, trustee);
    t.append(key).append(&r);
    t.challenge() == proof.c
}

/// `ciphertext` encrypts 0 or 1, under `poll_key`, and the proof was made for `voter`'s ballot,
/// for option `option`.
pub fn is_bit(
    voter: &ContractAddress,
    option: u32,
    poll_key: &Point,
    ciphertext: &Ciphertext,
    proof: &BitProof,
) -> bool {
    if !is_reduced(&proof.c0) || !is_reduced(&proof.c1) {
        return false;
    }
    let Ciphertext { a, b } = ciphertext;
    // If it encrypts 0, `(a, b)` is `(r·G, r·Y)`.
    let a0 = Sum::<2>::new()
        .add(&proof.s0, &G)
        .add(&neg(&proof.c0), a)
        .eval();
    let b0 = Sum::<2>::new()
        .add(&proof.s0, poll_key)
        .add(&neg(&proof.c0), b)
        .eval();
    // If it encrypts 1, `(a, b − G)` is.
    let a1 = Sum::<2>::new()
        .add(&proof.s1, &G)
        .add(&neg(&proof.c1), a)
        .eval();
    let b1 = Sum::<3>::new()
        .add(&proof.s1, poll_key)
        .add(&neg(&proof.c1), b)
        .add(&proof.c1, &G)
        .eval();
    let (Some(a0), Some(b0), Some(a1), Some(b1)) = (a0, b0, a1, b1) else {
        return false;
    };
    let mut t = Transcript::new(BIT, voter);
    t.append(&option.to_le_bytes())
        .append(poll_key)
        .append(a)
        .append(b)
        .append(&a0)
        .append(&b0)
        .append(&a1)
        .append(&b1);
    t.challenge() == add(&proof.c0, &proof.c1)
}

/// The ciphertexts, added up, encrypt exactly 1: with each one a 0 or a 1, the ballot chooses one
/// option. The proof was made for `voter`.
///
/// Their sum `(A, B)` is `(R·G, G + R·Y)` for the sum `R` of the voter's randomness, so this is a
/// proof that `log_G A = log_Y (B − G)`. The sums are folded into the check's own sums.
pub fn is_one_choice(
    voter: &ContractAddress,
    poll_key: &Point,
    ciphertexts: &[Ciphertext],
    proof: &Proof,
) -> bool {
    if !is_reduced(&proof.c) {
        return false;
    }
    let minus_c = neg(&proof.c);
    // T₁ = s·G − c·A, and T₂ = s·Y − c·(B − G).
    let mut t1 = Sum::<{ OPTIONS + 1 }>::new();
    let mut t2 = Sum::<{ OPTIONS + 2 }>::new();
    t1.add(&proof.s, &G);
    t2.add(&proof.s, poll_key).add(&proof.c, &G);
    for Ciphertext { a, b } in ciphertexts {
        t1.add(&minus_c, a);
        t2.add(&minus_c, b);
    }
    let (Some(t1), Some(t2)) = (t1.eval(), t2.eval()) else {
        return false;
    };
    let mut t = Transcript::new(ONE_CHOICE, voter);
    t.append(poll_key);
    for Ciphertext { a, b } in ciphertexts {
        t.append(a).append(b);
    }
    t.append(&t1).append(&t2);
    t.challenge() == proof.c
}

/// `share` is `x·total` for the `x` behind `trustee`'s `key`: `log_G key = log_total share`. It
/// is the trustee's part of decrypting option `option`'s total.
pub fn is_share(
    trustee: &ContractAddress,
    option: u32,
    key: &Point,
    total: &Point,
    share: &Point,
    proof: &Proof,
) -> bool {
    // U = s·G − c·key, and V = s·total − c·share.
    let (Some(u), Some(v)) = (commitment(proof, &G, key), commitment(proof, total, share)) else {
        return false;
    };
    let mut t = Transcript::new(SHARE, trustee);
    t.append(&option.to_le_bytes())
        .append(key)
        .append(total)
        .append(share)
        .append(&u)
        .append(&v);
    t.challenge() == proof.c
}

// s·base − c·point: what a prover committed to, if its proof is sound.
fn commitment(proof: &Proof, base: &Point, point: &Point) -> Option<Point> {
    if !is_reduced(&proof.c) {
        return None;
    }
    Sum::<2>::new()
        .add(&proof.s, base)
        .add(&neg(&proof.c), point)
        .eval()
}
