//! The parameter set: OpenFHE's `STD128` for the GINX (CGGI) bootstrapping method.
//!
//! Values are taken from `BinFHEContext::GenerateBinFHEContext` in OpenFHE's
//! `src/binfhe/lib/binfhecontext.cpp`. One value differs: the key-switching base (see
//! [`KS_BASE_BITS`]).

/// LWE dimension of a ciphertext (`latParam`).
pub const LWE_N: usize = 554;
/// LWE ciphertext modulus (`modq`). It equals `2 * RING_N`, so a ciphertext's mask entries are
/// exponents of `X` in the ring without rescaling.
pub const LWE_Q: u32 = 2048;
/// Ring dimension of the accumulator: `cycOrder / 2`.
pub const RING_N: usize = 1024;
/// Ring modulus: OpenFHE's `LastPrime(27, 2048)`, the largest 27-bit prime that is `1 mod 2048`
/// (`2^27 - 2^11 + 1`). Every polynomial product is an NTT modulo this prime.
pub const RING_Q: u32 = 134_215_681;
/// Key-switching modulus (`modKS`).
pub const KS_Q_BITS: u32 = 15;
pub const KS_Q: u32 = 1 << KS_Q_BITS;
/// Key-switching digit width, in bits.
///
/// OpenFHE's `STD128` uses base `2^8`, and stores every multiple `j * 2^(8k)` of every digit: about
/// 391,000 LWE samples, over 400 MB. Base 2 stores one sample per bit, 15,360 samples (17 MB), so
/// that a key fits on chain. Its noise is larger (see the README); the security of the key is
/// unchanged, since it is still LWE under the same secret, modulus and noise.
pub const KS_BASE_BITS: u32 = 1;
pub const KS_BASE: u32 = 1 << KS_BASE_BITS;
/// Digits of a value below `KS_Q` (OpenFHE's `GetDigitCount(qKS, baseKS)`).
pub const KS_DIGITS: usize = KS_Q_BITS.div_ceil(KS_BASE_BITS) as usize;
/// Standard deviation of every error term (`stdDev`).
pub const SIGMA: f64 = 3.19;

/// The gadget base of the bootstrapping key differs between LWE coefficients (`gadgetBaseMap`
/// `{{128, 303}, {512, 251}}`): the first 303 secret coefficients use base `2^7`, the remaining 251
/// base `2^9`.
pub const GADGET_SPLIT: usize = 303;

/// Gadget base of one LWE coefficient's bootstrapping key, in bits.
pub const fn gadget_bits(i: usize) -> u32 {
    if i < GADGET_SPLIT { 7 } else { 9 }
}

/// Digits of a value below `RING_Q` in that base (`GetDigitCount(Q, baseG)`): 4 for `2^7`, 3 for
/// `2^9`.
pub const fn gadget_digits(i: usize) -> usize {
    27usize.div_ceil(gadget_bits(i) as usize)
}

/// Rows of one RGSW ciphertext. The approximate gadget decomposition drops the lowest digit, and
/// each remaining digit has a row for each of the accumulator's two polynomials.
pub const fn rgsw_rows(i: usize) -> usize {
    (gadget_digits(i) - 1) * 2
}

/// Polynomials of the bootstrapping key for LWE coefficient `i`: two RGSW ciphertexts (one for a
/// secret coefficient of `+1`, one for `-1`), each `rgsw_rows` rows of two polynomials.
pub const fn bsk_polys_for(i: usize) -> usize {
    2 * rgsw_rows(i) * 2
}

/// Index of the first bootstrapping-key polynomial of LWE coefficient `i`.
pub const fn bsk_offset(i: usize) -> usize {
    if i < GADGET_SPLIT {
        i * bsk_polys_for(0)
    } else {
        GADGET_SPLIT * bsk_polys_for(0) + (i - GADGET_SPLIT) * bsk_polys_for(GADGET_SPLIT)
    }
}

/// Index of one bootstrapping-key polynomial: coefficient `i`, `sign` 0 for the RGSW encryption of
/// `[s_i = 1]` and 1 for `[s_i = -1]`, RGSW `row`, and `col` (0 for the mask, 1 for the body).
pub const fn bsk_index(i: usize, sign: usize, row: usize, col: usize) -> usize {
    bsk_offset(i) + (sign * rgsw_rows(i) + row) * 2 + col
}

/// Polynomials in a whole bootstrapping key: 303 * 24 + 251 * 16 = 11,288.
pub const BSK_POLYS: usize = bsk_offset(LWE_N);

/// Number of distinct values the key-switching digit at position `k` can take: the full base,
/// except the top digit of a value below `KS_Q` (OpenFHE's `GetDigitExtentKS`).
pub const fn ks_digit_extent(k: usize) -> u32 {
    if k + 1 < KS_DIGITS {
        KS_BASE
    } else {
        ((KS_Q - 1) >> (KS_BASE_BITS * (KS_DIGITS as u32 - 1))) + 1
    }
}

/// Key-switching samples per ring coefficient: one for every nonzero digit value at every digit.
pub const KS_ROWS_PER_COEFF: usize = {
    let mut rows = 0;
    let mut k = 0;
    while k < KS_DIGITS {
        rows += ks_digit_extent(k) as usize - 1;
        k += 1;
    }
    rows
};

/// Index of the key-switching sample that encrypts `j * KS_BASE^k * z_i`, where `z` is the ring
/// secret.
pub const fn ks_index(i: usize, j: u32, k: usize) -> usize {
    let mut offset = 0;
    let mut d = 0;
    while d < k {
        offset += ks_digit_extent(d) as usize - 1;
        d += 1;
    }
    i * KS_ROWS_PER_COEFF + offset + (j as usize - 1)
}

/// Samples in a whole key-switching key: 1024 * 15 = 15,360 at base 2.
pub const KS_SAMPLES: usize = RING_N * KS_ROWS_PER_COEFF;

/// Key-switching samples per storage value. A gate reads the samples of every nonzero digit of
/// 1024 coefficients, and a cold read costs far more than its bytes, so samples are stored three
/// to a value: about 4.4 reads per coefficient instead of 7.5.
pub const KS_GROUP: usize = 3;
/// Storage values in a whole key-switching key: 5,120.
pub const KS_GROUPS: usize = KS_SAMPLES / KS_GROUP;
const _: () = assert!(
    KS_ROWS_PER_COEFF.is_multiple_of(KS_GROUP),
    "a group never spans two coefficients"
);

/// Bytes of one bootstrapping-key polynomial as stored: 1024 little-endian `u32`.
pub const POLY_BYTES: usize = RING_N * 4;
/// Bytes of one key-switching sample as stored: `LWE_N + 1` little-endian `u16` (mask, then body).
pub const KS_SAMPLE_BYTES: usize = (LWE_N + 1) * 2;
/// Bytes of one stored group of [`KS_GROUP`] samples: 3,330.
pub const KS_GROUP_BYTES: usize = KS_GROUP * KS_SAMPLE_BYTES;
/// Bytes of a packed LWE ciphertext: `LWE_N + 1` values of 11 bits.
pub const LWE_BYTES: usize = ((LWE_N + 1) * 11).div_ceil(8);

/// What a network charges in deposit for one stored item, in native-token base units: a base
/// cost plus a cost per byte (`storageCosts` in `getChainConfig`). A contract cannot read them,
/// so its deployer passes them to `initialize`, and the client checks them against the chain.
/// The contract charges each keyset's funds at these rates for the storage it makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageRates {
    pub item: u128,
    pub byte: u128,
}

/// The rates of the local and hosted networks today (`baseDataItemCost`, `bytestringCostPerByte`).
pub const HOSTED_RATES: StorageRates = StorageRates {
    item: 12_000,
    byte: 10,
};

/// Bytes counted for a small typed value (a header, a counter, a balance): more than any of them
/// takes, so that a keyset is never charged less than the network takes.
pub const SMALL_VALUE_BYTES: usize = 64;

/// Bytes of an extracted ciphertext as a job stores it: `RING_N + 1` little-endian `u16`.
pub const BIG_BYTES: usize = (RING_N + 1) * 2;

impl StorageRates {
    /// The deposit for one item of `bytes` bytes.
    pub const fn deposit(&self, bytes: usize) -> u128 {
        self.item + self.byte * bytes as u128
    }

    /// A gate job's working state, deleted (and credited back) when the job finishes: the
    /// combined input, the two accumulator polynomials, the extracted ciphertext and the partial
    /// key switch.
    pub const fn job_state(&self) -> u128 {
        self.deposit(LWE_BYTES)
            + 2 * self.deposit(POLY_BYTES)
            + self.deposit(BIG_BYTES)
            + self.deposit(KS_SAMPLE_BYTES)
    }

    /// Everything a gate may store, charged by `start_gate`: the job's header, its working state
    /// and the result. About 0.02 native tokens.
    pub const fn job(&self) -> u128 {
        self.deposit(SMALL_VALUE_BYTES) + self.job_state() + self.ciphertext()
    }

    /// One stored ciphertext: the keyset id and the packed ciphertext.
    pub const fn ciphertext(&self) -> u128 {
        self.deposit(8 + LWE_BYTES)
    }

    /// A whole keyset, reserved by `create_keyset`: its header, upload counter and funds, and
    /// every piece of its evaluation key. About 83 native tokens.
    pub const fn keyset(&self) -> u128 {
        3 * self.deposit(SMALL_VALUE_BYTES)
            + BSK_POLYS as u128 * self.deposit(POLY_BYTES)
            + KS_GROUPS as u128 * self.deposit(KS_GROUP_BYTES)
    }

    /// [`keyset`](Self::keyset) with checked arithmetic: `None` if it would overflow `u128`.
    /// The keyset is the largest charge, so rates for which this fits fit every other charge.
    pub fn checked_keyset(&self) -> Option<u128> {
        let deposit = |bytes: usize| self.byte.checked_mul(bytes as u128)?.checked_add(self.item);
        let small = deposit(SMALL_VALUE_BYTES)?.checked_mul(3)?;
        let bsk = deposit(POLY_BYTES)?.checked_mul(BSK_POLYS as u128)?;
        let ksk = deposit(KS_GROUP_BYTES)?.checked_mul(KS_GROUPS as u128)?;
        small.checked_add(bsk)?.checked_add(ksk)
    }
}
