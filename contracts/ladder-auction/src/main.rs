//! RV32 binary wrapper for the `ladder-auction` contract library.
//!
//! `thruput build` builds this bin with the `entrypoints` feature, so the
//! `#[contract]` macro emits the rv32 method entry symbols; referencing the
//! library is what links them in.

#![no_std]
#![no_main]

extern crate ladder_auction;
