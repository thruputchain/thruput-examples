//! The FHE scheme shared by the contract and its client: FHEW/TFHE-style gate bootstrapping
//! (the CGGI/GINX blind rotation) with OpenFHE's `STD128` parameters, in exact integer
//! arithmetic, so that every validator computes the same bits.
//!
//! * [`params`]: the parameter set and the layout of the evaluation key.
//! * [`ntt`]: arithmetic modulo the 27-bit ring prime and the negacyclic NTT.
//! * [`lwe`]: ciphertexts of one bit and the gates that need no key (NOT, and the linear part
//!   of every other gate).
//! * [`bootstrap`]: the blind rotation, one LWE coefficient per step, and key switching.
//!
//! Nothing here allocates, and no buffer is larger than a few polynomials: the contract runs this
//! code in 64 KiB of guest memory, reading the evaluation key one storage value at a time.
#![no_std]

pub mod bootstrap;
pub mod lwe;
pub mod ntt;
pub mod params;

pub use bootstrap::{Evaluator, Gate, KeySource};
pub use lwe::Lwe;
