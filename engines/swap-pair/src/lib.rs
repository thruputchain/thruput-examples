//! A port of UniswapV2 from Solidity to groundhog
//!
//! N.B.: This contract suite is for example purposes only; it has not been
//! audited thoroughly for production use.
//!
//! Refer to the UniswapV2 [whitepaper] and [v2-core] repository for details.
//!
//! [whitepaper]: https://docs.uniswap.org/whitepaper.pdf
//! [v2-core]: https://github.com/Uniswap/v2-core

//! This is not a contract.  The pair's operations are performed inside the
//! handler's own invocation, which is what lets a batch of them share one
//! transaction -- and what makes the sender and request id on the resulting
//! events worth something, since only the handler can name them.
//!
//! The operations keep the names and shapes of their UniswapV2Pair
//! counterparts; each is documented against the original.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

pub mod u256;

mod pair;
pub(crate) mod reserves;

// The value types and errors the pair shares with the rest of the suite.
pub use swap_if::{Address, Addresses, Amount, Amounts, ERC20Error, SwapPairError};

pub mod events;

pub use pair::Pair;

// Re-export the ERC20 trait for `dyn ERC20` in tests
#[cfg(feature = "dev")]
pub use groundhog_erc20_if::ERC20;
