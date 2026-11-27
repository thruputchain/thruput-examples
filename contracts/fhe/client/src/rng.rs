//! Randomness for key generation and encryption: SHA-256 in counter mode over a 32-byte seed,
//! seeded from the operating system or, for a reproducible demo key, from a public string.

use sha2::{Digest, Sha256};
use std::io::Read;

pub struct Rng {
    seed: [u8; 32],
    counter: u64,
    block: [u8; 32],
    used: usize,
}

impl Rng {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Rng {
            seed,
            counter: 0,
            block: [0; 32],
            used: 32,
        }
    }

    /// A seed from `/dev/urandom`.
    pub fn from_os() -> Self {
        let mut seed = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut seed))
            .expect("read /dev/urandom");
        Rng::from_seed(seed)
    }

    /// A seed derived from a string. Anyone who knows the string can recompute everything this
    /// generator produces.
    pub fn from_phrase(phrase: &str) -> Self {
        Rng::from_seed(Sha256::digest(phrase.as_bytes()).into())
    }

    fn byte(&mut self) -> u8 {
        if self.used == 32 {
            let mut h = Sha256::new();
            h.update(self.seed);
            h.update(self.counter.to_le_bytes());
            self.block = h.finalize().into();
            self.counter += 1;
            self.used = 0;
        }
        self.used += 1;
        self.block[self.used - 1]
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut b = [0u8; 8];
        for x in b.iter_mut() {
            *x = self.byte();
        }
        u64::from_le_bytes(b)
    }

    /// Uniform in `[0, bound)`, by rejection.
    pub fn below(&mut self, bound: u32) -> u32 {
        let mask = bound.next_power_of_two().wrapping_sub(1);
        loop {
            let x = self.next_u64() as u32 & mask;
            if x < bound {
                return x;
            }
        }
    }

    /// Uniform in `{-1, 0, 1}`.
    pub fn ternary(&mut self) -> i8 {
        self.below(3) as i8 - 1
    }

    /// A discrete Gaussian sample with standard deviation [`fhe_core::params::SIGMA`], by
    /// inversion of its cumulative distribution. The table runs to 16 sigma, but in `f64` the
    /// cumulative probability reaches 1 at about |k| = 27 (8.5 sigma), so no sample is larger;
    /// what is cut off has probability below 2^-53.
    pub fn gaussian(&mut self) -> i32 {
        let table = cdt();
        let u = self.next_u64() >> 1;
        let k = table.iter().position(|&c| u < c).unwrap_or(table.len() - 1) as i32;
        if k != 0 && self.next_u64() & 1 == 1 {
            -k
        } else {
            k
        }
    }
}

/// `cdt()[k]` is `P(|x| <= k) * 2^63`.
fn cdt() -> &'static [u64] {
    static TABLE: std::sync::OnceLock<Vec<u64>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let sigma = fhe_core::params::SIGMA;
        let tail = (16.0 * sigma) as i32;
        let rho = |k: i32| (-(k as f64).powi(2) / (2.0 * sigma * sigma)).exp();
        let total: f64 = (-tail..=tail).map(rho).sum();
        let mut acc = 0.0;
        (0..=tail)
            .map(|k| {
                acc += if k == 0 { rho(0) } else { 2.0 * rho(k) } / total;
                (acc.min(1.0) * (1u64 << 63) as f64) as u64
            })
            .collect()
    })
}
