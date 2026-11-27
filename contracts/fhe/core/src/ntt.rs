//! Arithmetic modulo the ring prime, and the negacyclic NTT.
//!
//! Products use Montgomery multiplication with `R = 2^32`: [`mul`] returns `a * b / R mod Q`. A
//! value stored "in Montgomery form" is `x * R mod Q`, so multiplying by it yields a plain
//! product. Twiddle factors and bootstrapping-key polynomials are kept in Montgomery form;
//! everything else holds plain residues in `[0, Q)`. RV32 has a 32x32 -> 64-bit multiply but no
//! fast 64-bit division, which is why the reduction avoids `%`.

use crate::params::{RING_N, RING_Q};

const Q: u32 = RING_Q;
const N: usize = RING_N;

/// `-Q^-1 mod 2^32`, by Newton iteration.
const Q_NEG_INV: u32 = {
    let mut inv: u32 = 1;
    let mut i = 0;
    while i < 5 {
        inv = inv.wrapping_mul(2u32.wrapping_sub(Q.wrapping_mul(inv)));
        i += 1;
    }
    inv.wrapping_neg()
};

/// `R mod Q`: the Montgomery form of 1.
pub const R1: u32 = ((1u64 << 32) % Q as u64) as u32;
/// `R^2 mod Q`, to bring a plain residue into Montgomery form.
const R2: u32 = (((1u128 << 64) % Q as u128) as u64) as u32;

/// Montgomery product `a * b * 2^-32 mod Q`, for `a, b < Q`; the result is below `Q`.
#[inline(always)]
pub const fn mul(a: u32, b: u32) -> u32 {
    let u = mul_lazy(a, b);
    if u >= Q { u - Q } else { u }
}

/// Montgomery product without the final subtraction: for any `a` and `b < Q`, the result is
/// below `2Q`, since `a * b < Q * 2^32`. Lets sums of products be reduced once, not per term.
///
/// `(a*b + m*Q) / 2^32` is computed from the high halves of the two products alone: their low
/// halves sum to 0 mod `2^32` by the choice of `m`, so they carry exactly when `a*b`'s low half
/// is nonzero. On RV32 that is two `mul`s, two `mulhu`s and three cheap instructions.
#[inline(always)]
pub const fn mul_lazy(a: u32, b: u32) -> u32 {
    let lo = a.wrapping_mul(b);
    let hi = ((a as u64 * b as u64) >> 32) as u32;
    let m = lo.wrapping_mul(Q_NEG_INV);
    let mq = ((m as u64 * Q as u64) >> 32) as u32;
    hi + mq + (lo != 0) as u32
}

/// Reduce a value below `2^32` to `[0, Q)`.
#[inline(always)]
pub const fn reduce(a: u32) -> u32 {
    a % Q
}

#[inline(always)]
pub const fn add(a: u32, b: u32) -> u32 {
    let s = a + b;
    if s >= Q { s - Q } else { s }
}

#[inline(always)]
pub const fn sub(a: u32, b: u32) -> u32 {
    if a >= b { a - b } else { a + Q - b }
}

/// Montgomery form of a plain residue.
pub const fn to_mont(a: u32) -> u32 {
    mul(a, R2)
}

/// A primitive `2N`-th root of unity mod `Q`: `7^((Q - 1) / 2N)`, 7 being the least generator of
/// the multiplicative group.
pub const PSI: u32 = 4_073_518;

/// `PSI^j` in Montgomery form, for `j < 2N`. Every twiddle factor, and the NTT of every monomial
/// `X^j`, is an entry of this table.
pub static PSI_POW: [u32; 2 * N] = {
    let mut t = [0u32; 2 * N];
    let psi = to_mont(PSI);
    t[0] = R1;
    let mut j = 1;
    while j < 2 * N {
        t[j] = mul(t[j - 1], psi);
        j += 1;
    }
    t
};

/// Ten-bit bit reversal: the NTT's output order.
pub static BIT_REV: [u16; N] = {
    let mut t = [0u16; N];
    let mut i = 0;
    while i < N {
        t[i] = (i as u16).reverse_bits() >> 6;
        i += 1;
    }
    t
};

/// `N^-1` in Montgomery form, applied at the end of the inverse transform.
const N_INV_MONT: u32 = {
    // N^-1 = (Q - (Q - 1) / N) mod Q, since N divides Q - 1.
    to_mont(Q - (Q - 1) / N as u32)
};

/// Forward negacyclic NTT in place (Cooley-Tukey, natural order in, bit-reversed order out).
/// Output slot `k` is the polynomial evaluated at `PSI^(2 * BIT_REV[k] + 1)`. Inputs below `Q`;
/// outputs reduced to `[0, Q)`.
pub fn forward(a: &mut [u32; N]) {
    forward_lazy(a);
    for x in a.iter_mut() {
        *x = reduce(*x);
    }
}

/// [`forward`] without any reduction, for inputs below `Q`: each of the ten stages adds less
/// than `2Q` to the bound (`x + v` and `x + 2Q - v`, with `v < 2Q` from [`mul_lazy`]), so the
/// outputs stay below `21Q < 2^32`, which is all that [`mul_lazy`] needs of its first operand.
pub fn forward_lazy(a: &mut [u32; N]) {
    const Q2: u32 = 2 * Q;
    let mut t = N;
    let mut m = 1;
    while m < N {
        t >>= 1;
        for i in 0..m {
            let w = PSI_POW[BIT_REV[m + i] as usize];
            let (lo, hi) = a[2 * i * t..2 * i * t + 2 * t].split_at_mut(t);
            for (x, y) in lo.iter_mut().zip(hi.iter_mut()) {
                let u = *x;
                let v = mul_lazy(*y, w);
                *x = u + v;
                *y = u + Q2 - v;
            }
        }
        m <<= 1;
    }
}

/// Inverse of [`forward`] (Gentleman-Sande, bit-reversed order in, natural order out), including
/// the division by `N`. Inputs below `2Q`; outputs reduced to `[0, Q)`.
pub fn inverse(a: &mut [u32; N]) {
    const Q2: u32 = 2 * Q;
    let mut t = 1;
    let mut m = N;
    while m > 1 {
        let h = m >> 1;
        for i in 0..h {
            // PSI^-k = PSI^(2N - k)
            let w = PSI_POW[(2 * N - BIT_REV[h + i] as usize) % (2 * N)];
            let (lo, hi) = a[2 * i * t..2 * i * t + 2 * t].split_at_mut(t);
            for (x, y) in lo.iter_mut().zip(hi.iter_mut()) {
                let (u, v) = (*x, *y);
                let s = u + v;
                *x = if s >= Q2 { s - Q2 } else { s };
                *y = mul_lazy(u + Q2 - v, w);
            }
        }
        t <<= 1;
        m = h;
    }
    for x in a.iter_mut() {
        *x = mul(*x, N_INV_MONT);
    }
}

/// Slot `k` of the NTT of `X^e - 1`, in Montgomery form.
#[inline(always)]
pub fn monomial_minus_one(e: u32, k: usize) -> u32 {
    let exponent = e.wrapping_mul(2 * BIT_REV[k] as u32 + 1) as usize % (2 * N);
    sub(PSI_POW[exponent], R1)
}
