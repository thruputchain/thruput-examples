//! The NTT against schoolbook negacyclic multiplication, and the monomial shortcut against a
//! transform of `X^e - 1`.

// Index loops read as the formulas they check.
#![allow(clippy::needless_range_loop)]

use fhe_core::ntt;
use fhe_core::params::{RING_N, RING_Q};

fn pseudo_random(seed: u64) -> [u32; RING_N] {
    let mut x = seed;
    core::array::from_fn(|_| {
        x = x
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((x >> 33) % RING_Q as u64) as u32
    })
}

fn schoolbook(a: &[u32; RING_N], b: &[u32; RING_N]) -> [u32; RING_N] {
    let q = RING_Q as u64;
    let mut c = [0u64; RING_N];
    for i in 0..RING_N {
        for j in 0..RING_N {
            let p = a[i] as u64 * b[j] as u64 % q;
            let k = (i + j) % RING_N;
            c[k] = if i + j < RING_N {
                (c[k] + p) % q
            } else {
                (c[k] + q - p) % q
            };
        }
    }
    c.map(|x| x as u32)
}

#[test]
fn psi_is_a_primitive_2n_th_root() {
    let pow = |mut b: u64, mut e: u64| {
        let mut r = 1u64;
        while e > 0 {
            if e & 1 == 1 {
                r = r * b % RING_Q as u64;
            }
            b = b * b % RING_Q as u64;
            e >>= 1;
        }
        r
    };
    assert_eq!(pow(ntt::PSI as u64, RING_N as u64), RING_Q as u64 - 1);
}

#[test]
fn round_trip() {
    let a = pseudo_random(1);
    let mut b = a;
    ntt::forward(&mut b);
    assert_ne!(a, b);
    ntt::inverse(&mut b);
    assert_eq!(a, b);
}

#[test]
fn product_is_negacyclic() {
    let a = pseudo_random(2);
    let b = pseudo_random(3);
    let (mut fa, mut fb) = (a, b);
    ntt::forward(&mut fa);
    ntt::forward(&mut fb);
    let mut c: [u32; RING_N] = core::array::from_fn(|k| ntt::mul(fa[k], ntt::to_mont(fb[k])));
    ntt::inverse(&mut c);
    assert_eq!(c, schoolbook(&a, &b));
}

#[test]
fn monomials() {
    for e in [1u32, 2, 511, 1023, 1024, 1025, 2047] {
        let mut m = [0u32; RING_N];
        m[0] = RING_Q - 1;
        let e_mod = (e as usize) % (2 * RING_N);
        if e_mod < RING_N {
            m[e_mod] = ntt::add(m[e_mod], 1);
        } else {
            m[e_mod - RING_N] = ntt::sub(m[e_mod - RING_N], 1);
        }
        ntt::forward(&mut m);
        for k in 0..RING_N {
            assert_eq!(
                ntt::to_mont(m[k]),
                ntt::monomial_minus_one(e, k),
                "e={e} k={k}"
            );
        }
    }
}
