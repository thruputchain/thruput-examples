//! A SPEEDEX-style batch exchange: every offer in a batch clears at one set of valuation prices.
//!
//! [`engine`] is the arithmetic -- the price-level grid, tâtonnement over aggregate supply and
//! demand, and the per-offer settlement rule -- as plain functions with no storage behind them, so
//! it can be tested (and reasoned about) on its own. [`Speedex`] is the contract that stores the
//! batches and moves the tokens.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

sdk::declare_mock_contract!();

pub mod engine;

mod contract;
pub use contract::*;
