//! The pair's interface now lives in the `swap-if` crate; re-export it so the
//! implementation and tests can keep referring to `crate::interface::*` /
//! `swap_pair::*`.

pub use swap_if::{
    Address, Addresses, Amount, Amounts, ERC20Error, SwapPair, SwapPairClient, SwapPairClientError,
    SwapPairError,
};
