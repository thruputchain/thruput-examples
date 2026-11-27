//! Gate bootstrapping, one step at a time.
//!
//! A bootstrapped gate is: a linear combination of the input ciphertexts ([`crate::lwe`]); an
//! accumulator holding a test polynomial ([`init_accumulator`]); one [`blind_rotate_step`] per
//! LWE coefficient, which multiplies the accumulator by `X^(-a_i * s_i)` under encryption; and
//! [`extract`], which reads an LWE ciphertext of the gate's output out of coefficient 0. Key
//! switching ([`KeySwitch`]) and two modulus switches then bring it back to the input format.
//!
//! The functions take key material through [`KeySource`] one piece at a time and work in
//! caller-provided buffers, so that the same code runs natively and in a 64 KiB contract guest.

use crate::ntt;
use crate::params::*;

/// One polynomial: `RING_N` residues mod `RING_Q`.
pub type Poly = [u32; RING_N];

/// The accumulator, an RLWE ciphertext `(mask, body)` with coefficients mod `RING_Q`. Between
/// steps it is kept in coefficient form, which is what the gadget decomposition reads.
pub type Accumulator = [Poly; 2];

/// One key-switching sample: `LWE_N` mask values and the body, mod `KS_Q`.
pub type KsSample = [u16; LWE_N + 1];
/// [`KS_GROUP`] consecutive samples: one storage value.
pub type KsGroup = [KsSample; KS_GROUP];

/// Where the evaluation key comes from: memory natively, contract storage in the guest. Each
/// piece is lent to a closure rather than copied out, so that a contract can hand over the
/// buffer it read the storage value into, and needs no key buffer of its own.
pub trait KeySource {
    /// Call `f` with bootstrapping-key polynomial `index` (see [`bsk_index`]), in NTT form with
    /// each value in Montgomery form.
    fn bsk_poly(&mut self, index: usize, f: impl FnOnce(&Poly));
    /// Call `f` with key-switching samples `KS_GROUP * group ..` (see [`ks_index`]).
    fn ks_group(&mut self, group: usize, f: impl FnOnce(&KsGroup));
}

/// Working memory of a blind-rotation step, 20 KiB: two RLWE products in NTT form and the
/// current digit polynomial.
pub struct StepScratch {
    products: [[Poly; 2]; 2],
    digit: Poly,
}

impl StepScratch {
    pub const fn new() -> Self {
        StepScratch {
            products: [[[0; RING_N]; 2]; 2],
            digit: [0; RING_N],
        }
    }
}

impl Default for StepScratch {
    fn default() -> Self {
        Self::new()
    }
}

/// The gates that need a bootstrap, with OpenFHE's gate constants (`m_gateConst`, in eighths of
/// `LWE_Q`): the gate outputs 0 when the combined phase falls in `[c, c + q/2)` (a half-turn),
/// and 1 otherwise, before the swap described in [`init_accumulator`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Gate {
    Or = 0,
    And = 1,
    Nor = 2,
    Nand = 3,
    Xor = 4,
    Xnor = 5,
}

impl Gate {
    pub const ALL: [Gate; 6] = [
        Gate::Or,
        Gate::And,
        Gate::Nor,
        Gate::Nand,
        Gate::Xor,
        Gate::Xnor,
    ];

    pub fn from_index(v: u32) -> Option<Gate> {
        Gate::ALL.get(v as usize).copied()
    }

    /// The gate constant, in units of `LWE_Q / 8`.
    const fn eighths(self) -> u32 {
        match self {
            Gate::Or => 5,
            Gate::And => 7,
            Gate::Nor => 1,
            Gate::Nand => 3,
            Gate::Xor => 6,
            Gate::Xnor => 2,
        }
    }

    /// XOR and XNOR combine `2 * (c1 + c2)` rather than `c1 + c2`.
    pub const fn doubles(self) -> bool {
        matches!(self, Gate::Xor | Gate::Xnor)
    }

    /// The plaintext truth table, for tests and the reference evaluator.
    pub const fn eval(self, x: bool, y: bool) -> bool {
        match self {
            Gate::Or => x | y,
            Gate::And => x & y,
            Gate::Nor => !(x | y),
            Gate::Nand => !(x & y),
            Gate::Xor => x ^ y,
            Gate::Xnor => !(x ^ y),
        }
    }
}

/// `Q/8 + 1`: the magnitude of the test polynomial's coefficients (OpenFHE's `Q2p`).
const Q8: u32 = RING_Q / 8 + 1;

/// Load the test polynomial for `gate` into the accumulator, given the body `b` of the combined
/// ciphertext (OpenFHE's `BootstrapGateCore`).
///
/// Coefficient `i` answers for phase `b - i`: `-Q/8` inside the gate's half-turn `[lb, ub)` and
/// `+Q/8` outside it, or the reverse when the half-turn wraps past `LWE_Q`. After the blind
/// rotation multiplies by `X^-(a.s)`, coefficient 0 answers for the phase `b - a.s` itself.
pub fn init_accumulator(acc: &mut Accumulator, gate: Gate, b: u32) {
    let q1 = gate.eighths() * (LWE_Q / 8);
    let q2 = (q1 + LWE_Q / 2) % LWE_Q;
    let swap = q1 >= q2;
    let (lb, ub) = if swap { (q2, q1) } else { (q1, q2) };
    let (inside, outside) = if swap {
        (Q8, RING_Q - Q8)
    } else {
        (RING_Q - Q8, Q8)
    };
    acc[0] = [0; RING_N];
    for (i, c) in acc[1].iter_mut().enumerate() {
        let phase = (b + LWE_Q - (i as u32 % LWE_Q)) % LWE_Q;
        *c = if lb <= phase && phase < ub {
            inside
        } else {
            outside
        };
    }
}

/// One step of the blind rotation (OpenFHE's `AddToAccCGGI`, with the ternary MUX of
/// eprint 2022/074): for LWE coefficient `i` with mask entry `a_i`,
///
/// `acc += (acc ⊡ BK[i,+]) * (X^-a_i - 1) + (acc ⊡ BK[i,-]) * (X^a_i - 1)`
///
/// where `⊡` is the external product with an RGSW ciphertext and `BK[i,±]` encrypt
/// `[s_i = ±1]`. Exactly one of them encrypts 1 when `s_i` is nonzero, so the accumulator is
/// multiplied by `X^(-a_i * s_i)`.
///
/// The two external products share one gadget decomposition of the accumulator. Each digit
/// polynomial is transformed once and multiplied by four key polynomials, read one at a time.
/// The monomials are applied in NTT form, and two inverse transforms bring the update back to
/// coefficient form. A step reads [`bsk_polys_for`]`(i)` key polynomials (24 or 16) and runs
/// `rgsw_rows(i) + 2` transforms (8 or 6).
pub fn blind_rotate_step(
    acc: &mut Accumulator,
    s: &mut StepScratch,
    keys: &mut impl KeySource,
    i: usize,
    a_i: u32,
) {
    // The rotation exponent -a_i, mod 2N (= LWE_Q). With a zero exponent both monomials vanish.
    let e = (LWE_Q - a_i % LWE_Q) % LWE_Q;
    if e == 0 {
        return;
    }

    let bits = gadget_bits(i);
    let rows = rgsw_rows(i);
    let g_half = 1u32 << (bits - 1);
    let g_mask = (1u32 << bits) - 1;
    // Excess-H signed digits: add half the base at every digit position, then each digit is an
    // unsigned window minus half the base (OpenFHE's `ExcessHDigitDecompose`).
    let mut h = 0u32;
    for d in 0..gadget_digits(i) as u32 {
        h += g_half << (d * bits);
    }

    for p in s.products.iter_mut().flatten() {
        p.fill(0);
    }
    for row in 0..rows {
        // Row 2l decomposes the mask, row 2l + 1 the body, at digit l + 1 (digit 0 is dropped).
        let src = &acc[row & 1];
        let shift = (row as u32 / 2 + 1) * bits;
        // The top window keeps the carry out of the last digit.
        let mask = if row + 2 < rows { g_mask } else { u32::MAX };
        for (d, &x) in s.digit.iter_mut().zip(src.iter()) {
            let w = x + h - if x < RING_Q / 2 { 0 } else { RING_Q };
            let r = (w >> shift) & mask;
            *d = if r < g_half {
                r + RING_Q - g_half
            } else {
                r - g_half
            };
        }
        ntt::forward_lazy(&mut s.digit);
        for sign in 0..2 {
            for col in 0..2 {
                let (out, digit) = (&mut s.products[sign][col], &s.digit);
                keys.bsk_poly(bsk_index(i, sign, row, col), |key| {
                    // Each term is below 2Q and a step sums at most 6, so the sum stays below
                    // 2^31.
                    for ((o, &d), &k) in out.iter_mut().zip(digit.iter()).zip(key.iter()) {
                        *o += ntt::mul_lazy(d, k);
                    }
                });
            }
        }
    }

    // products[0] * (X^e - 1) + products[1] * (X^-e - 1), into products[0].
    let [plus, minus] = &mut s.products;
    for k in 0..RING_N {
        let mp = ntt::monomial_minus_one(e, k);
        let mm = ntt::monomial_minus_one(LWE_Q - e, k);
        for col in 0..2 {
            let sum = ntt::mul_lazy(plus[col][k], mp) + ntt::mul_lazy(minus[col][k], mm);
            plus[col][k] = if sum >= 2 * RING_Q {
                sum - 2 * RING_Q
            } else {
                sum
            };
        }
    }
    for col in 0..2 {
        ntt::inverse(&mut plus[col]);
        for (x, &y) in acc[col].iter_mut().zip(plus[col].iter()) {
            *x = ntt::add(*x, y);
        }
    }
}

/// Read the gate's output out of the rotated accumulator as an LWE ciphertext of dimension
/// `RING_N` (sample extraction at coefficient 0), shift its phase from `±Q/8` to `{0, Q/4}`, and
/// round it to the key-switching modulus.
///
/// The mask is the accumulator's mask under `X -> X^-1`: `a'_0 = a_0`, `a'_j = -a_(N-j)`, so that
/// `a'.z` is coefficient 0 of `a * z`.
pub fn extract(acc: &Accumulator, out: &mut KsBig) {
    let to_ks = |x: u32| -> u16 {
        // round(x * KS_Q / RING_Q), mod KS_Q
        let r = (x as u64 * KS_Q as u64 + RING_Q as u64 / 2) / RING_Q as u64;
        (r as u32 & (KS_Q - 1)) as u16
    };
    out.a[0] = to_ks(acc[0][0]);
    for j in 1..RING_N {
        out.a[j] = to_ks(ntt::sub(0, acc[0][RING_N - j]));
    }
    out.b = to_ks(ntt::add(acc[1][0], Q8));
}

/// An LWE ciphertext of dimension `RING_N` mod `KS_Q`, under the ring secret: the input to key
/// switching.
#[derive(Clone)]
pub struct KsBig {
    pub a: [u16; RING_N],
    pub b: u16,
}

impl KsBig {
    pub const fn new() -> Self {
        KsBig {
            a: [0; RING_N],
            b: 0,
        }
    }
}

impl Default for KsBig {
    fn default() -> Self {
        Self::new()
    }
}

/// Key switching from the ring secret (dimension `RING_N`) to the LWE secret (dimension `LWE_N`),
/// mod `KS_Q` (OpenFHE's `KeySwitch`), one input coefficient at a time so that a contract can
/// spread it over transactions.
///
/// For every digit `j` of every mask entry `a_i` (in base `KS_BASE`), the sample encrypting
/// `j * KS_BASE^k * z_i` is subtracted. `KS_Q` is a power of two, so arithmetic is wrapping `u16`
/// arithmetic masked to 15 bits.
#[derive(Clone)]
pub struct KeySwitch {
    pub a: [u16; LWE_N],
    pub b: u16,
}

impl KeySwitch {
    pub const fn new() -> Self {
        KeySwitch {
            a: [0; LWE_N],
            b: 0,
        }
    }

    /// Absorb mask entry `a_i` (mod `KS_Q`) of coefficient `i`. Each group of samples is read
    /// once, and only if one of its samples is needed.
    pub fn absorb(&mut self, keys: &mut impl KeySource, i: usize, a_i: u16) {
        // The sample index of every nonzero digit, in increasing order.
        let mut needed = [usize::MAX; KS_DIGITS];
        let mut rest = a_i as u32;
        for (k, slot) in needed.iter_mut().enumerate() {
            let j = rest & (KS_BASE - 1);
            rest >>= KS_BASE_BITS;
            if j != 0 {
                *slot = ks_index(i, j, k);
            }
        }
        let mut k = 0;
        while k < KS_DIGITS {
            if needed[k] == usize::MAX {
                k += 1;
                continue;
            }
            let group = needed[k] / KS_GROUP;
            keys.ks_group(group, |samples| {
                while k < KS_DIGITS && (needed[k] == usize::MAX || needed[k] / KS_GROUP == group) {
                    if needed[k] != usize::MAX {
                        let sample = &samples[needed[k] % KS_GROUP];
                        for (x, &y) in self.a.iter_mut().zip(sample.iter()) {
                            *x = x.wrapping_add(y);
                        }
                        self.b = self.b.wrapping_add(sample[LWE_N]);
                    }
                    k += 1;
                }
            });
        }
    }

    /// Finish with the body `b` of the input and round to the LWE modulus: the gate's output.
    pub fn finish(&self, b: u16) -> crate::lwe::Lwe {
        let mask = (KS_Q - 1) as u16;
        // round(x * LWE_Q / KS_Q) mod LWE_Q
        let down = |x: u16| -> u16 {
            let shift = KS_Q_BITS - 11;
            ((((x & mask) as u32 + (1 << (shift - 1))) >> shift) % LWE_Q) as u16
        };
        let mut out = crate::lwe::Lwe::zero();
        for (o, &x) in out.a.iter_mut().zip(self.a.iter()) {
            *o = down(x.wrapping_neg());
        }
        out.b = down(b.wrapping_sub(self.b));
        out
    }
}

impl Default for KeySwitch {
    fn default() -> Self {
        Self::new()
    }
}

/// Everything a whole gate needs natively: the reference evaluator. A contract runs the same
/// pieces spread over transactions.
pub struct Evaluator {
    pub acc: Accumulator,
    pub scratch: StepScratch,
    pub big: KsBig,
    pub ks: KeySwitch,
}

impl Evaluator {
    pub const fn new() -> Self {
        Evaluator {
            acc: [[0; RING_N]; 2],
            scratch: StepScratch::new(),
            big: KsBig::new(),
            ks: KeySwitch::new(),
        }
    }

    /// Bootstrap an already-combined ciphertext through `gate`'s test polynomial.
    pub fn bootstrap(
        &mut self,
        keys: &mut impl KeySource,
        gate: Gate,
        ct: &crate::lwe::Lwe,
    ) -> crate::lwe::Lwe {
        init_accumulator(&mut self.acc, gate, ct.b as u32);
        for i in 0..LWE_N {
            blind_rotate_step(&mut self.acc, &mut self.scratch, keys, i, ct.a[i] as u32);
        }
        extract(&self.acc, &mut self.big);
        self.ks = KeySwitch::new();
        for i in 0..RING_N {
            self.ks.absorb(keys, i, self.big.a[i]);
        }
        self.ks.finish(self.big.b)
    }

    /// Evaluate `gate` on two ciphertexts.
    pub fn gate(
        &mut self,
        keys: &mut impl KeySource,
        gate: Gate,
        x: &crate::lwe::Lwe,
        y: &crate::lwe::Lwe,
    ) -> crate::lwe::Lwe {
        let combined = crate::lwe::combine(gate, x, y);
        self.bootstrap(keys, gate, &combined)
    }
}

impl Default for Evaluator {
    fn default() -> Self {
        Self::new()
    }
}
