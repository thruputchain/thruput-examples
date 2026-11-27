//! The client side of the FHE example: key generation, encryption and decryption, and the
//! evaluation key in memory, which also makes a native reference evaluator (the contract's step
//! code run against [`EvalKey`]).
//!
//! The secret key never leaves the client. The evaluation key (bootstrapping key and
//! key-switching key) is public: it is what the contract reads to compute on ciphertexts.

#[cfg(feature = "node")]
pub mod node;
pub mod rng;

use fhe_core::Lwe;
use fhe_core::bootstrap::{KeySource, KsGroup, KsSample, Poly};
use fhe_core::ntt;
use fhe_core::params::*;
pub use rng::Rng;

/// The secret key: the LWE secret that ciphertexts are encrypted under, and the ring secret
/// that the accumulator and the bootstrapping key use. Both are uniform ternary.
#[derive(Clone)]
pub struct SecretKey {
    pub lwe: [i8; LWE_N],
    pub ring: [i8; RING_N],
}

/// The public evaluation key.
pub struct EvalKey {
    /// [`BSK_POLYS`] polynomials in NTT form, values in Montgomery form; see
    /// [`bsk_index`].
    pub bsk: Vec<Poly>,
    /// [`KS_SAMPLES`] LWE samples mod `KS_Q`; see [`ks_index`].
    pub ksk: Vec<KsSample>,
}

impl SecretKey {
    pub fn generate(rng: &mut Rng) -> Self {
        let mut sk = SecretKey {
            lwe: [0; LWE_N],
            ring: [0; RING_N],
        };
        sk.lwe.iter_mut().for_each(|x| *x = rng.ternary());
        sk.ring.iter_mut().for_each(|x| *x = rng.ternary());
        sk
    }

    /// Encrypt one bit: `b = a.s + bit * q/4 + e mod q` (OpenFHE's symmetric `Encrypt`).
    pub fn encrypt(&self, bit: bool, rng: &mut Rng) -> Lwe {
        let mut ct = Lwe::zero();
        let mut dot = 0i64;
        for (a, &s) in ct.a.iter_mut().zip(self.lwe.iter()) {
            *a = rng.below(LWE_Q) as u16;
            dot += *a as i64 * s as i64;
        }
        let b = dot + bit as i64 * (LWE_Q / 4) as i64 + rng.gaussian() as i64;
        ct.b = b.rem_euclid(LWE_Q as i64) as u16;
        ct
    }

    pub fn decrypt(&self, ct: &Lwe) -> bool {
        ct.decrypt(&self.lwe)
    }

    /// The signed distance of a ciphertext's phase from the encoding of `bit`, mod `q`: its noise.
    pub fn noise(&self, ct: &Lwe, bit: bool) -> i32 {
        let ideal = bit as i32 * (LWE_Q / 4) as i32;
        let d = (ct.phase(&self.lwe) as i32 - ideal).rem_euclid(LWE_Q as i32);
        if d >= LWE_Q as i32 / 2 {
            d - LWE_Q as i32
        } else {
            d
        }
    }

    /// Generate the evaluation key for this secret key.
    pub fn eval_key(&self, rng: &mut Rng) -> EvalKey {
        EvalKey {
            bsk: self.bootstrapping_key(rng),
            ksk: self.key_switching_key(rng),
        }
    }

    /// The ring secret in NTT form.
    fn ring_ntt(&self) -> Poly {
        let mut z = [0u32; RING_N];
        for (x, &s) in z.iter_mut().zip(self.ring.iter()) {
            *x = (s as i64).rem_euclid(RING_Q as i64) as u32;
        }
        ntt::forward(&mut z);
        z
    }

    fn noise_poly(rng: &mut Rng) -> Poly {
        let mut e = [0u32; RING_N];
        for x in e.iter_mut() {
            *x = (rng.gaussian() as i64).rem_euclid(RING_Q as i64) as u32;
        }
        ntt::forward(&mut e);
        e
    }

    /// For each LWE coefficient `i`, RGSW encryptions of `[s_i = 1]` and `[s_i = -1]` under the
    /// ring secret `z` (OpenFHE's `KeyGenAcc` and `RGSWEncrypt`). Row `r` holds an RLWE
    /// encryption of zero `(a, a*z + e)`, plus `m * B^(r/2 + 1)` in its mask (even `r`) or its
    /// body (odd `r`), `B` being coefficient `i`'s gadget base.
    pub fn bootstrapping_key(&self, rng: &mut Rng) -> Vec<Poly> {
        let z_mont = self.ring_ntt().map(ntt::to_mont);
        let mut bsk = vec![[0u32; RING_N]; BSK_POLYS];
        for i in 0..LWE_N {
            for sign in 0..2 {
                let m = (sign == 0 && self.lwe[i] == 1) || (sign == 1 && self.lwe[i] == -1);
                for row in 0..rgsw_rows(i) {
                    let mut a = [0u32; RING_N];
                    a.iter_mut().for_each(|x| *x = rng.below(RING_Q));
                    let e = Self::noise_poly(rng);
                    let mut body = [0u32; RING_N];
                    for k in 0..RING_N {
                        body[k] = ntt::add(ntt::mul(a[k], z_mont[k]), e[k]);
                    }
                    if m {
                        // m * B^level at coefficient 0 is the constant B^level in every NTT slot.
                        let level = row as u32 / 2 + 1;
                        let g = ((1u64 << (gadget_bits(i) * level)) % RING_Q as u64) as u32;
                        let target = if row & 1 == 0 { &mut a } else { &mut body };
                        target.iter_mut().for_each(|x| *x = ntt::add(*x, g));
                    }
                    bsk[bsk_index(i, sign, row, 0)] = a.map(ntt::to_mont);
                    bsk[bsk_index(i, sign, row, 1)] = body.map(ntt::to_mont);
                }
            }
        }
        bsk
    }

    /// For each ring-secret coefficient `z_i`, digit position `k` and digit value `j`, an LWE
    /// encryption mod `KS_Q` of `j * KS_BASE^k * z_i` under the LWE secret (OpenFHE's
    /// `KeySwitchGen`).
    pub fn key_switching_key(&self, rng: &mut Rng) -> Vec<KsSample> {
        let mask = (KS_Q - 1) as u16;
        let mut ksk = vec![[0u16; LWE_N + 1]; KS_SAMPLES];
        for i in 0..RING_N {
            for k in 0..KS_DIGITS {
                for j in 1..ks_digit_extent(k) {
                    let sample = &mut ksk[ks_index(i, j, k)];
                    let mut b = (rng.gaussian() as i64
                        + j as i64 * (KS_BASE as i64).pow(k as u32) * self.ring[i] as i64)
                        as u16;
                    for (slot, &s) in sample.iter_mut().zip(self.lwe.iter()) {
                        let a = rng.below(KS_Q) as u16;
                        *slot = a;
                        b = b.wrapping_add(a.wrapping_mul(s as i16 as u16));
                    }
                    sample[LWE_N] = b & mask;
                }
            }
        }
        ksk
    }
}

impl KeySource for EvalKey {
    fn bsk_poly(&mut self, index: usize, f: impl FnOnce(&Poly)) {
        f(&self.bsk[index]);
    }

    fn ks_group(&mut self, group: usize, f: impl FnOnce(&KsGroup)) {
        f(self.ksk[group * KS_GROUP..][..KS_GROUP].try_into().unwrap());
    }
}

impl EvalKey {
    /// A bootstrapping-key polynomial as stored on chain: 1024 little-endian `u32`.
    pub fn bsk_bytes(&self, index: usize) -> Vec<u8> {
        self.bsk[index]
            .iter()
            .flat_map(|x| x.to_le_bytes())
            .collect()
    }

    /// A group of key-switching samples as stored on chain: [`KS_GROUP`] samples of `LWE_N + 1`
    /// little-endian `u16` each.
    pub fn ks_group_bytes(&self, group: usize) -> Vec<u8> {
        self.ksk[group * KS_GROUP..][..KS_GROUP]
            .iter()
            .flatten()
            .flat_map(|x| x.to_le_bytes())
            .collect()
    }
}
