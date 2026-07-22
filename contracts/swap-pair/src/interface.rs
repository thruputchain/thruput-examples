use crate::u256::U256;
use core::fmt;
pub use groundhog_erc20_if::ERC20Error;
use sdk::*;

#[contract_exception]
#[non_exhaustive]
pub enum SwapPairError {
    InitializeFailed = 1,
    AlreadyInitialized = 2,
    NoLiquidityToBurn = 3,
    InsufficientOutputAmount = 4,
    InsufficientInputAmount = 5,
    InsufficientLiquidity = 6,
    InsufficientLiquidityMinted = 7,
    InsufficientLiquidityBurned = 8,
    InvalidDestination = 9,
    InvalidSwapProduct = 10,
    Overflow = 11,
    TransferFailed = 12,
    LPTokenFailure(ERC20Error) = 13,
}

impl fmt::Display for SwapPairError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SwapV2{:?}", self)
    }
}

pub type Amount = u128;

// A pair of amounts, corresponding to the two tokens in a swap pair.
pub type Amounts = [Amount; 2];

pub type Address = sdk::ContractAddress;
pub type Addresses = [sdk::ContractAddress; 2];

#[contract(client = SwapPairClient, throws(SwapPairError, ERC20Error))]
pub trait SwapPair {
    // event Approval
    // event Transfer

    /// Must be called exactly once before any other methods
    fn initialize(
        &mut self,
        factory: &Address,
        token0: &Address,
        token1: &Address,
        // A deployed but *uninitialized* ERC20 token contract.  This method
        // adopts it as the LP token and initializes it under the pair's
        // control.
        // TODO: Consider the security implications of this arrangement.
        lp_token: &Address,
        // Recipient of the protocol fee (1/6 of the growth in sqrt(k) between
        // liquidity events).  `None` disables the fee -- this stands in for
        // UniswapV2's factory-held `feeTo` until a factory exists.
        fee_to: Option<Address>,
    );

    fn liquidity_token(&self) -> ContractAddress;

    fn get_reserves(&self) -> (u128, u128, u32);
    fn get_liquidity(&self) -> Amount;

    /// The last-recorded cumulative prices, as UQ112x112 fixed-point values
    /// (`[price0, price1]`), for use as a time-weighted-average-price oracle.
    fn get_cumulative_prices(&self) -> [U256; 2];

    fn mint_lp(&mut self, to: &Address) -> Amount;
    fn burn_lp(&mut self, to: &Address) -> Amounts;

    fn skim(&mut self, to: &Address);
    fn sync(&mut self);

    fn swap(&mut self, amount0_out: Amount, amount1_out: Amount, to: &Address);
}
