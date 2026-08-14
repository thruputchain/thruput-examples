//! The factory interface: deploys and wires a whole suite (cf. UniswapV2Factory).

use crate::{Address, ERC20Error, PoolCreated, SwapLibraryError, SwapPairError, SwapRequestError};
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
pub struct Suite {
    pub pair: Address,
    pub liquidity_token: Address,
    pub handler: Address,
    pub driver: Address,
}

/// The code hashes of the contracts the factory deploys.
#[contract_type]
#[derive(Copy, Clone, Debug)]
pub struct SwapHashes {
    pub token: SHA256Hash,
    pub pair: SHA256Hash,
    pub handler: SHA256Hash,
    pub driver: SHA256Hash,
}

/// A factory that deploys and initializes a pair's contracts, and holds the
/// protocol `fee_to` that its pairs consult (cf. UniswapV2Factory).
///
/// `create_pair` deploys and initializes several sub-contracts, so its `throws`
/// includes their error types.  (The router is a single, suite-wide contract
/// deployed separately and pointed at the factory, so it is not part of a
/// pair's [`Suite`].)
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
    fn create_pair(&mut self, token_a: &Address, token_b: &Address) -> Suite;

    /// The addresses [`create_pair`] would deploy the suite to for this token
    /// pair, computed deterministically without deploying anything (like a
    /// create2 prediction).  Useful for pre-funding the contracts on a
    /// cost-bearing network, where each must be solvent before it is
    /// initialized.
    ///
    /// [`create_pair`]: Self::create_pair
    fn predict_pair(&self, token_a: &Address, token_b: &Address) -> Suite;

    /// The pair created for `token_a`/`token_b`, if any (order-independent).
    fn get_pair(&self, token_a: &Address, token_b: &Address) -> Option<Address>;

    /// The number of pairs created so far.
    fn all_pairs_length(&self) -> u32;

    /// The pair at `index` in creation order, if in bounds.
    fn pair_at(&self, index: u32) -> Option<Address>;
}
