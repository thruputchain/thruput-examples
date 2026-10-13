//! A port of UniswapV2 from Solidity to groundhog
//!
//! N.B.: This contract suite is for example purposes only; it has not been
//! audited thoroughly for production use.
//!
//! Refer to the UniswapV2 [whitepaper] and [v2-core] repository for details.
//!
//! [whitepaper]: https://docs.uniswap.org/whitepaper.pdf
//! [v2-core]: https://github.com/Uniswap/v2-core

//! This is not a contract.  In groundhog, each pair operation is enqueued as a
//! request to `swap-driver`, and performed inside a handler of `swap-handler`;
//! this allows executing a batch of them in one transaction and thus
//! multiplies how many swap-pair operations can be performed in each block.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

mod pair;

pub use pair::{Pair, from_token, to_token};

pub(crate) mod reserves;

// The value types and errors the pair shares with the rest of the suite.
pub use swap_if::{Address, Addresses, Amount, Amounts, ERC20Error, SwapPairError};

pub mod events {
    // Re-export the pair events for the implementation and tests
    pub use swap_if::{LiquidityBurnEvent, LiquidityMintEvent, SwapEvent, SyncEvent};
}

pub mod u256 {
    // Re-export for implementation and tests
    pub use swap_if::{U256, mul_div_u128};
}

// Re-export the ERC20 trait for `dyn ERC20` in tests
#[cfg(feature = "dev")]
pub use thruput_erc20_if::ERC20;
