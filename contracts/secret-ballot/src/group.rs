//! Just enough Ristretto255 to check a ballot's proofs on chain.
//!
//! The runtime adds up multiples of points, `s₁·P₁ + … + sₙ·Pₙ`, in one call: the experimental
//! `ristretto255_msm` syscall. Every proof this contract checks comes down to a few such sums, so
//! the contract needs only three operations on scalars of its own: add two, negate one, and check
//! that one is below the group order. Points stay opaque 32-byte encodings throughout; the
//! runtime decodes and validates them.

use thruput_sdk::crypto::ristretto255_msm;
use thruput_sdk::*;

/// A compressed Ristretto255 point, as the runtime takes and returns it.
pub type Point = [u8; 32];

/// An integer modulo the group order ℓ, 32 bytes little-endian.
pub type Scalar = [u8; 32];

/// The standard generator.
pub const G: Point = [
    0xe2, 0xf2, 0xae, 0x0a, 0x6a, 0xbc, 0x4e, 0x71, 0xa8, 0x84, 0xa9, 0x61, 0xc5, 0x00, 0x51, 0x5f,
    0x58, 0xe3, 0x0b, 0x6a, 0xa5, 0x82, 0xdd, 0x8d, 0xb6, 0xa6, 0x59, 0x45, 0xe0, 0x8d, 0x2d, 0x76,
];

/// The identity, the group's zero. A proof checks out when its sum comes to this.
pub const IDENTITY: Point = [0; 32];

pub const ONE: Scalar = from_u64(1);
pub const MINUS_ONE: Scalar = neg(&ONE);

// ℓ = 2^252 + 27742317777372353535851937790883648493, in little-endian 64-bit limbs.
const L: [u64; 4] = [
    0x5812_631a_5cf5_d3ed,
    0x14de_f9de_a2f7_9cd6,
    0,
    0x1000_0000_0000_0000,
];

pub const fn from_u64(n: u64) -> Scalar {
    to_bytes([n, 0, 0, 0])
}

/// Whether `s` is below ℓ: the runtime refuses any other scalar, and `neg` and `add` assume it.
pub const fn is_reduced(s: &Scalar) -> bool {
    sub(to_limbs(s), L).1
}

/// `-s` modulo ℓ, for a reduced `s`.
pub const fn neg(s: &Scalar) -> Scalar {
    let s = to_limbs(s);
    if s[0] | s[1] | s[2] | s[3] == 0 {
        return to_bytes(s);
    }
    to_bytes(sub(L, s).0)
}

/// `a + b` modulo ℓ, for reduced `a` and `b`. Their sum is below 2ℓ < 2^254, so it takes at most
/// one subtraction of ℓ.
pub const fn add(a: &Scalar, b: &Scalar) -> Scalar {
    let (a, b) = (to_limbs(a), to_limbs(b));
    let mut sum = [0u64; 4];
    let mut carry = 0;
    let mut i = 0;
    while i < 4 {
        let (s, c1) = a[i].overflowing_add(b[i]);
        let (s, c2) = s.overflowing_add(carry);
        sum[i] = s;
        carry = (c1 | c2) as u64;
        i += 1;
    }
    match sub(sum, L) {
        (_, true) => to_bytes(sum),
        (reduced, false) => to_bytes(reduced),
    }
}

// `a - b`, and whether it borrowed: whether `a < b`.
const fn sub(a: [u64; 4], b: [u64; 4]) -> ([u64; 4], bool) {
    let mut diff = [0u64; 4];
    let mut borrow = false;
    let mut i = 0;
    while i < 4 {
        let (d, b1) = a[i].overflowing_sub(b[i]);
        let (d, b2) = d.overflowing_sub(borrow as u64);
        diff[i] = d;
        borrow = b1 | b2;
        i += 1;
    }
    (diff, borrow)
}

const fn to_limbs(s: &Scalar) -> [u64; 4] {
    let mut limbs = [0u64; 4];
    let mut i = 0;
    while i < 32 {
        limbs[i / 8] |= (s[i] as u64) << (8 * (i % 8));
        i += 1;
    }
    limbs
}

const fn to_bytes(limbs: [u64; 4]) -> Scalar {
    let mut s = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        s[i] = (limbs[i / 8] >> (8 * (i % 8))) as u8;
        i += 1;
    }
    s
}

/// A sum of up to `N` multiples of points, `s₁·P₁ + … + sₙ·Pₙ`, that the runtime evaluates in
/// one call. It is built on the stack: the guest's heap is never freed, so a contract that sums
/// in a loop must not allocate.
pub struct Sum<const N: usize> {
    terms: [[u8; 64]; N],
    len: usize,
}

impl<const N: usize> Sum<N> {
    pub fn new() -> Self {
        Self {
            terms: [[0; 64]; N],
            len: 0,
        }
    }

    /// Add `s·p`. Panics if all `N` terms are taken: the caller sizes `N` for its worst case.
    pub fn add(&mut self, s: &Scalar, p: &Point) -> &mut Self {
        let term = &mut self.terms[self.len];
        term[..32].copy_from_slice(s);
        term[32..].copy_from_slice(p);
        self.len += 1;
        self
    }

    /// The point the terms add up to, or `None` if some scalar is not reduced or some point is
    /// not a valid encoding.
    pub fn eval(&self) -> Option<Point> {
        ristretto255_msm(self.terms[..self.len].as_flattened())
            .ok()
            .map(|point| point.into_inner())
    }
}

impl<const N: usize> Default for Sum<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// The Fiat–Shamir transcript of a proof. A proof's challenge is the hash of everything it is
/// about: what kind of proof it is, the poll (this contract's address), who it is for, the
/// statement, and the prover's commitments. So a proof made for one voter, or one poll, is no
/// proof for another.
pub struct Transcript(Hasher);

impl Transcript {
    pub fn new(kind: &[u8], who: &ContractAddress) -> Self {
        let mut hasher = Hasher::new();
        hasher.update(&kind);
        hasher.update(&get_current_address().into_inner());
        hasher.update(&who.into_inner());
        Self(hasher)
    }

    pub fn append(&mut self, bytes: &[u8]) -> &mut Self {
        self.0.update(&bytes);
        self
    }

    /// The challenge: the hash, with its top four bits cleared. That leaves it below 2^252, which
    /// is below ℓ, so it is already a reduced scalar.
    pub fn challenge(self) -> Scalar {
        let mut c = self.0.finish().into_inner();
        c[31] &= 0x0f;
        c
    }
}
