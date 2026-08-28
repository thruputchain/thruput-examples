//! The factory interface: deploys and wires a whole pool (cf. UniswapV2Factory).

use crate::{
    Address, Addresses, ERC20Error, PoolCreated, SwapLibraryError, SwapPairError, SwapRequestError,
};
use core::fmt;
use sdk::*;

#[contract_exception]
#[non_exhaustive]
pub enum SwapFactoryError {
    AlreadyInitialized = 1,
    IdenticalTokens = 2,
    ZeroAddress = 3,
    PairExists = 4,
}

impl fmt::Display for SwapFactoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SwapFactory{:?}", self)
    }
}

/// The set of contracts the factory creates and wires together for one token
/// pair, returned by [`SwapFactory::create_pair`].
#[contract_type]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Pool {
    pub liquidity_token: Address,

    /// The pool itself: it performs the pair's operations, holds its tokens,
    /// and answers for its state.
    pub handler: Address,

    pub driver: Address,
}

/// The code hashes of the contracts the factory deploys.
#[contract_type]
#[derive(Copy, Clone, Debug)]
pub struct SwapHashes {
    pub token: SHA256Hash,
    pub handler: SHA256Hash,
    pub driver: SHA256Hash,
}

/// A factory that deploys and initializes a pair's contracts, and holds the
/// protocol `fee_to` that its pairs consult (cf. UniswapV2Factory).
///
/// `create_pair` deploys and initializes several sub-contracts, so its `throws`
/// includes their error types.  (The router is a single, suite-wide contract
/// deployed separately and pointed at the factory, so it is not part of a
/// pair's [`Pool`].)
#[contract(
    client = SwapFactoryClient,
    throws(SwapFactoryError, ERC20Error, SwapPairError, SwapRequestError, SwapLibraryError),
    emits(PoolCreated)
)]
pub trait SwapFactory {
    /// Configure the factory with the code hashes of the contracts it deploys
    /// and the protocol-fee recipient (`None` disables the fee).
    fn initialize(&mut self, hashes: SwapHashes, fee_to: Option<Address>);

    /// The protocol-fee recipient, consulted by each pair's fee logic.
    fn fee_to(&self) -> Option<Address>;

    /// Deploy and initialize a pair's contracts (LP token, pair, request
    /// handler, driver) for the given token pair, in one transaction.
    fn create_pair(&mut self, token_a: &Address, token_b: &Address) -> Pool;

    /// The addresses [`create_pair`] would deploy the pool to for this token
    /// pair, computed deterministically without deploying anything (like a
    /// create2 prediction).  Useful for pre-funding the contracts on a
    /// cost-bearing network, where each must be solvent before it is
    /// initialized -- and, since the prediction holds for pools that already
    /// exist, for resolving a created pool's contracts from its tokens.
    ///
    /// [`create_pair`]: Self::create_pair
    fn pool_addresses(&self, token_a: &Address, token_b: &Address) -> Pool;

    /// The pair created for `token_a`/`token_b`, if any (order-independent).
    fn get_pair(&self, token_a: &Address, token_b: &Address) -> Option<Address>;

    /// The number of pairs created so far.
    fn all_pairs_length(&self) -> u32;

    /// The two tokens swapped by the pool at `index` in creation order, if in
    /// bounds, in the factory's canonical (ascending) order.
    ///
    /// Walking `0..all_pairs_length()` yields every pool's token pair, and
    /// feeding each to [`pool_addresses`] yields that pool's contract
    /// addresses -- so a client can enumerate the whole registry.
    ///
    /// [`pool_addresses`]: Self::pool_addresses
    fn pair_at(&self, index: u32) -> Option<Addresses>;
}
