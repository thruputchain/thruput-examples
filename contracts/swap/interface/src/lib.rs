//! Shared interfaces for the swap contract suite.
//!
//! This interface-only crate defines every swap contract's trait, its generated client and error
//! type, and the value types they exchange.
//!
//! The deployable crates (`swap-handler`, `swap-driver`, `swap-router`, `swap-factory`) each
//! implement their trait from here, so they can call one another without depending on each other's
//! implementations.
//!
//! ## How an operation happens
//!
//! A pool is three contracts the [`SwapFactory`] creates together for a token pair (see [`Pool`]):
//! the handler, which holds the reserves and performs operations; the driver, which queues requests
//! for it; and the LP token. One [`SwapRouter`] serves every pool.
//!
//! Unlike UniswapV2, an operation is not performed in the transaction that asks for it. Queuing
//! requests lets many accounts submit concurrently, and lets one transaction then perform a whole
//! batch of them. So an operation takes four steps, the middle two in separate transactions:
//!
//! 1. **Approve.** The account grants the pool's *handler* an allowance for the tokens the
//!    operation spends (the LP token, to remove liquidity). The handler pulls them when the request
//!    is performed, so the allowance must still stand then.
//! 2. **Request.** The account calls a [`SwapRouter`] method, such as
//!    [`swap_exact_tokens_for_tokens`](SwapRouter::swap_exact_tokens_for_tokens). The router looks
//!    the pool up through the factory and enqueues a [`SwapRequest`] with its driver, which stamps
//!    the request with a [`RequestId`], emits [`RequestAccepted`](batch_driver::RequestAccepted),
//!    and returns the id. Nothing is priced yet: the request records the account's amounts and
//!    limits, not a quote.
//! 3. **Crank.** Someone calls [`SwapDriver::process_requests`], in a transaction of its own. It
//!    drains the queue, handing each request to the handler, which prices it against the reserves
//!    as they stand at that moment and moves the tokens. The crank's gas limit decides how many
//!    requests it can take; see `swap_driver::process_requests_gas`.
//! 4. **Observe.** Each request ends in an event carrying its id: the handler's [`SwapEvent`],
//!    [`LiquidityMintEvent`] or [`LiquidityBurnEvent`] when it succeeds, or the driver's
//!    [`RequestFailed`](batch_driver::RequestFailed) when it does not. The account matches the id
//!    it was returned in step 2 against these.
//!
//! Between steps 2 and 3, other requests may move the price. A request's minimum (or maximum)
//! amounts are what protect it from that: one the reserves can no longer satisfy fails, rather
//! than filling at a worse price.
//!
//! Cranking needs no privilege, and only one crank per block can drain a given queue. Who should
//! crank, and when, is discussed in the `batch_driver` crate docs. The Swap app (`apps/swap`)
//! cranks once the account's request has committed. `swap-router`'s `sim_swap` test drives all four
//! steps on a local node, and reports how requests fare under different cranking policies.

#![cfg_attr(not(feature = "dev"), no_std)]

pub use thruput_erc20_if::ERC20Error;

/// A contract address.
pub type Address = thruput_sdk::ContractAddress;
/// A pair of addresses (the two tokens of a swap pair).
pub type Addresses = [thruput_sdk::ContractAddress; 2];
/// A token amount.
pub type Amount = u128;
/// A pair of amounts, one per token.
pub type Amounts = [Amount; 2];
/// A request identifier.
///
/// It is derived from the enqueuing transaction's hash and a per-transaction sequence number (see
/// [`SwapDriver::request`]) -- so it is unique even across several
/// requests in one transaction -- and is echoed into the event the request eventually produces,
/// letting the off-chain application track a request's lifecycle by polling for that event.
pub type RequestId = thruput_sdk::SHA256Hash;

extern crate alloc;

mod u256;
pub use u256::{U256, mul_div_u128};

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
