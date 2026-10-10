//! RV32 binary wrapper for the `stellar-account` contract library.
//!
//! `thruput build` builds this bin with the `entrypoints` feature so the
//! `#[contract]` macro emits rv32 method entry symbols. Referencing the
//! library links the macro-emitted symbols in; the runtime arrives
//! transitively through `sdk`'s rv32 runtime dependency.

#![no_std]
#![no_main]

extern crate stellar_account;
