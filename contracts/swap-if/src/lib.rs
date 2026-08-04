//! Shared interfaces for the swap contract suite.
//!
//! This interface-only crate defines every swap contract's trait, its
//! generated client and error type, and the value types they exchange.
//!
//! The deployable crates (`swap-pair`, `swap-handler`, `swap-driver`,
//! `swap-router`, `swap-factory`) each implement their trait from here, so
//! they can call one another -- and be created by the factory -- without
//! depending on each other's implementations.

#![cfg_attr(not(feature = "dev"), no_std)]

pub use groundhog_erc20_if::ERC20Error;

/// A contract address.
pub type Address = sdk::ContractAddress;
/// A pair of addresses (the two tokens of a swap pair).
pub type Addresses = [sdk::ContractAddress; 2];
/// A token amount.
pub type Amount = u128;
/// A pair of amounts, one per token.
pub type Amounts = [Amount; 2];
/// A request identifier.
///
/// It is the hash of the transaction that enqueued the request (see
/// [`SwapDriver::request`](crate::SwapDriver::request)), echoed into the event
/// the request eventually produces so the off-chain application can track a
/// request's lifecycle by polling for that event.
pub type RequestId = sdk::SHA256Hash;

extern crate alloc;

mod u256;
pub use u256::U256;

mod events;
pub use events::*;

mod pair;
pub use pair::*;

mod handler;
pub use handler::*;

mod request;
pub use request::*;

mod driver;
pub use driver::*;

mod router;
pub use router::*;

mod factory;
pub use factory::*;
