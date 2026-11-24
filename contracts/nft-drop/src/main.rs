//! RV32 binary wrapper for the `nft-drop` contract library.
//!
//! `thruput build` builds this bin with the `entrypoints` feature, so the
//! `#[contract]` macros emit the method entry symbols. Referencing the
//! library is what links them in.

#![no_std]
#![no_main]

extern crate nft_drop;
