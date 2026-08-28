//! A factory that deploys and initializes the swap suite.
//!
//! Modeled on [UniswapV2Factory]: it holds the protocol `fee_to` (which each
//! pair consults via [`swap_if::SwapFactory::fee_to`]) and a registry of the
//! pairs it has created.  Its [`create_pair`] deploys a whole pool -- LP
//! token, pair, request handler, driver, and router -- and wires them together
//! in a single transaction.
//!
//! [UniswapV2Factory]: https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Factory.sol
//! [`create_pair`]: swap_if::SwapFactory::create_pair

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

mod factory;
pub use factory::Factory;

// Contract interface (re-exported for convenience)
pub use swap_if::{
    Address, Addresses, Pool, PoolCreated, SwapFactory, SwapFactoryClient, SwapFactoryClientError,
    SwapFactoryError, SwapHashes,
};
