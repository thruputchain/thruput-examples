//! LWE ciphertexts of one bit, and the operations that need no key.
//!
//! A ciphertext of bit `m` under secret `s` is `(a, b)` with `b = a.s + m * q/4 + e mod q`
//! (OpenFHE's plaintext modulus 4, of which a bit uses 0 and 1). Its *phase* is `b - a.s`.

use crate::bootstrap::Gate;
use crate::params::{LWE_BYTES, LWE_N, LWE_Q};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lwe {
    /// Mask, each entry mod `LWE_Q`.
    pub a: [u16; LWE_N],
    /// Body, mod `LWE_Q`.
    pub b: u16,
}

const MASK: u16 = (LWE_Q - 1) as u16;

impl Lwe {
    pub const fn zero() -> Self {
        Lwe {
            a: [0; LWE_N],
            b: 0,
        }
    }

    /// A noiseless encryption of a public bit, valid under every key.
    pub const fn constant(bit: bool) -> Self {
        Lwe {
            a: [0; LWE_N],
            b: if bit { (LWE_Q / 4) as u16 } else { 0 },
        }
    }

    /// Pack into [`LWE_BYTES`] bytes: the `LWE_N + 1` values (mask, then body) as consecutive
    /// little-endian 11-bit fields.
    pub fn to_bytes(&self) -> [u8; LWE_BYTES] {
        let mut out = [0u8; LWE_BYTES];
        let mut acc = 0u32;
        let mut bits = 0;
        let mut pos = 0;
        for &v in self.a.iter().chain(core::iter::once(&self.b)) {
            acc |= ((v & MASK) as u32) << bits;
            bits += 11;
            while bits >= 8 {
                out[pos] = acc as u8;
                pos += 1;
                acc >>= 8;
                bits -= 8;
            }
        }
        if bits > 0 {
            out[pos] = acc as u8;
        }
        out
    }

    /// The inverse of [`to_bytes`](Self::to_bytes); `None` unless `bytes` is exactly
    /// [`LWE_BYTES`] long with zero padding.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != LWE_BYTES {
            return None;
        }
        let mut out = Lwe::zero();
        let mut acc = 0u32;
        let mut bits = 0;
        let mut iter = bytes.iter();
        for idx in 0..=LWE_N {
            while bits < 11 {
                acc |= (*iter.next()? as u32) << bits;
                bits += 8;
            }
            let v = (acc as u16) & MASK;
            acc >>= 11;
            bits -= 11;
            if idx < LWE_N {
                out.a[idx] = v;
            } else {
                out.b = v;
            }
        }
        (acc == 0).then_some(out)
    }

    /// `b - a.s mod q` for a ternary secret given as `-1, 0, 1`.
    pub fn phase(&self, s: &[i8; LWE_N]) -> u16 {
        let mut dot = 0u32;
        for (&a, &si) in self.a.iter().zip(s.iter()) {
            dot = dot.wrapping_add((a as u32).wrapping_mul(si as i32 as u32));
        }
        (self.b as u32).wrapping_sub(dot) as u16 & MASK
    }

    /// Round the phase to the nearest multiple of `q/4`: OpenFHE's `Decrypt` with `p = 4`.
    pub fn decrypt(&self, s: &[i8; LWE_N]) -> bool {
        let r = (self.phase(s) as u32 + LWE_Q / 8) % LWE_Q;
        (r * 4 / LWE_Q) % 4 == 1
    }
}

/// `x + y`, and `2(x + y)` for XOR and XNOR (OpenFHE's `EvalBinGate` before bootstrapping).
pub fn combine(gate: Gate, x: &Lwe, y: &Lwe) -> Lwe {
    let k = if gate.doubles() { 2 } else { 1 };
    let mut out = Lwe::zero();
    for ((o, &p), &q) in out.a.iter_mut().zip(x.a.iter()).zip(y.a.iter()) {
        *o = (p.wrapping_add(q).wrapping_mul(k)) & MASK;
    }
    out.b = (x.b.wrapping_add(y.b).wrapping_mul(k)) & MASK;
    out
}

/// NOT without a bootstrap: `(-a, q/4 - b)` (OpenFHE's `EvalNOT`).
pub fn not(x: &Lwe) -> Lwe {
    let mut out = Lwe::zero();
    for (o, &p) in out.a.iter_mut().zip(x.a.iter()) {
        *o = p.wrapping_neg() & MASK;
    }
    out.b = ((LWE_Q / 4) as u16).wrapping_sub(x.b) & MASK;
    out
}
