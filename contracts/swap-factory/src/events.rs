use sdk::*;
use swap_if::Address;

/// Emitted when the factory creates a suite for a token pair (cf. UniswapV2's
/// `PairCreated`).
#[derive(Event, Clone, Debug, PartialEq, Eq, Hash)]
pub struct SuiteCreated<'a> {
    #[topic]
    pub token0: &'a Address,

    #[topic]
    pub token1: &'a Address,

    pub pair: Address,
    pub liquidity_token: Address,
    pub handler: Address,
    pub driver: Address,
    pub router: Address,

    /// The total number of pairs after this one was created.
    pub pair_count: u32,
}
