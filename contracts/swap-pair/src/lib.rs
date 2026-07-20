//! A port of UniswapV2 from Solidity to groundhog
//!
//! Refer to the UniswapV2 [whitepaper] and [v2-core] repository for details.
//!
//! [whitepaper](https://docs.uniswap.org/whitepaper.pdf)
//! [v2-core](https://github.com/Uniswap/v2-core)

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

extern crate alloc;

pub(crate) mod bignum;
pub(crate) mod interface;
#[cfg(feature = "implementation")]
mod pair;
#[cfg(feature = "implementation")]
pub(crate) mod reserves;

// Contract interface
pub mod events;
pub use interface::*;

// Contract implementation
#[cfg(feature = "implementation")]
pub use pair::SwapV2Pair;

// Re-export the ERC20 trait for `dyn ERC20` in tests
#[cfg(feature = "dev")]
pub use groundhog_erc20_if::ERC20;
