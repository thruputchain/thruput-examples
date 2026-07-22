//! Shared interfaces for the swap contract suite.
//!
//! This is an interface-only crate: it defines traits and their generated
//! clients so that contracts can call one another without depending on each
//! other's implementations.
//!
//! In particular, it breaks the cycle between `swap-pair` (which consults the
//! factory for the protocol `fee_to`) and `swap-factory` (which creates and
//! initializes pairs).

#![cfg_attr(not(feature = "dev"), no_std)]

use core::fmt;
use sdk::*;

pub type Address = sdk::ContractAddress;

#[contract_exception]
#[non_exhaustive]
pub enum SwapFactoryError {
    AlreadyInitialized = 1,
    IdenticalTokens = 2,
    ZeroAddress = 3,
    PairExists = 4,
    // A sub-contract's initialization call failed.  The factory can't name the
    // callees' error types (that would reintroduce the dependency cycle this
    // crate exists to break), so their failures collapse to this.
    SuiteInitFailed = 5,
}

impl fmt::Display for SwapFactoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SwapFactory{:?}", self)
    }
}

/// The set of contracts the factory creates and wires together for one token
/// pair, returned by [`SwapFactory::create_pair`].
#[contract_type]
#[derive(Copy, Clone, Debug)]
pub struct Suite {
    pub pair: Address,
    pub liquidity_token: Address,
    pub handler: Address,
    pub driver: Address,
    pub router: Address,
}

#[contract_type]
#[derive(Copy, Clone, Debug)]
pub struct SwapHashes {
    pub token: SHA256Hash,
    pub pair: SHA256Hash,
    pub handler: SHA256Hash,
    pub driver: SHA256Hash,
    pub router: SHA256Hash,
}

/// A factory that deploys and initializes the swap suite, and holds the
/// protocol `fee_to` that its pairs consult (cf. UniswapV2Factory).
#[contract(client = SwapFactoryClient, throws(SwapFactoryError))]
pub trait SwapFactory {
    /// Configure the factory with the code hashes of the contracts it deploys
    /// and the protocol-fee recipient (`None` disables the fee).
    fn initialize(&mut self, hashes: SwapHashes, fee_to: Option<Address>);

    /// The protocol-fee recipient, consulted by each pair's fee logic.
    fn fee_to(&self) -> Option<Address>;

    /// Deploy and initialize a full suite (LP token, pair, request handler,
    /// driver, router) for the given token pair, in one transaction.
    fn create_pair(&mut self, token_a: &Address, token_b: &Address) -> Suite;

    /// The pair created for `token_a`/`token_b`, if any (order-independent).
    fn get_pair(&self, token_a: &Address, token_b: &Address) -> Option<Address>;

    /// The number of pairs created so far.
    fn all_pairs_length(&self) -> u32;

    /// The pair at `index` in creation order.
    fn pair_at(&self, index: u32) -> Address;
}
