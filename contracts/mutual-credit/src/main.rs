//! RV32 binary wrapper for the `mutual-credit` contract library.
//!
//! `thruput build` builds this bin with the `entrypoints` feature, so the `#[contract]` macro
//! emits RV32 method entry symbols. Referencing the contract library links them in; the runtime
//! (`_start`, panic handler, allocator, linker script) arrives through `thruput-sdk`.

#![no_std]
#![no_main]

extern crate mutual_credit;
