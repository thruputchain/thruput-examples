//! The high-level swap-request handler interface.

use crate::{
    Address, Amount, Amounts, ERC20Error, LiquidityBurnEvent, LiquidityMintEvent, SwapEvent,
    SwapPairError, SwapRequest, SyncEvent, U256,
};
use thruput_sdk::*;

/// Everything a pool will tell you about itself, in one call.
#[contract_type]
pub struct PoolState {
    /// The last-recorded reserves, and when they were recorded.
    pub reserves: Amounts,
    pub block_timestamp: u32,

    /// The total supply of LP tokens.
    pub liquidity: Amount,

    /// The LP token this pool mints and burns.
    pub liquidity_token: Address,

    /// The cumulative prices, as UQ112x112 fixed-point values, for use as a
    /// time-weighted-average-price oracle.
    ///
    /// Recorded as of `block_timestamp`, and only when the reserves change: a `sync` that finds
    /// nothing new records nothing (see `Pair::sync`). The accumulator is a function of the
    /// reserves' history, so a consumer wanting its value at a later block extrapolates (each price
    /// times the blocks since `block_timestamp`, added on) exactly as UniswapV2's oracle library
    /// does with `price0CumulativeLast` and `blockTimestampLast`.
    pub cumulative_prices: [U256; 2],
}

/// Errors raised while handling a swap request (slippage limits exceeded).
#[contract_exception]
pub enum SwapRequestError {
    /// The request was handed to this contract by something other than the pool's driver.
    ///
    /// (This lives here, rather than on a handler-specific error type, because a distinct type
    /// costs several hundred bytes of encoding machinery.)
    Unauthorized = 100,

    InsufficientAmountA = 1,
    InsufficientAmountB = 2,
    InsufficientOutputAmount = 3,
    ExcessiveInputAmount = 4,
}

/// Errors from the price-optimizing library calculations.
#[contract_exception]
pub enum SwapLibraryError {
    InsufficientAmount = 1,
    InsufficientLiquidity = 2,
    InsufficientInputAmount = 3,
    InsufficientOutputAmount = 4,
}

/// The handler that performs high-level swap operations.
///
/// The driver enqueues opaque [`SwapRequest`]s and later forwards each one here (commit-locked and
/// gas-limited). This contract reads the live reserves, performs the optimizing calculation, moves
/// the user's tokens, and performs the underlying pair operations *itself* -- the pair is code it
/// runs, not a contract it calls, so a batch of requests shares one invocation.
///
/// It is therefore also the pool: it holds the pooled tokens, administers the LP token, and answers
/// for the pair's state.
#[contract(
    client = SwapHandlerClient,
    throws(SwapRequestError, SwapPairError, ERC20Error, SwapLibraryError),
    emits(LiquidityMintEvent, LiquidityBurnEvent, SwapEvent, SyncEvent)
)]
pub trait SwapHandler {
    /// Must be called exactly once before any other methods.
    ///
    /// `factory` is consulted for the protocol `fee_to`; `token0`/`token1` are the pool's
    /// underlying tokens; `lp_token` is a deployed but *uninitialized* ERC20 contract, which this
    /// method adopts as the LP token and initializes under its own control; `driver` is the only
    /// contract whose requests this one will handle.
    ///
    /// There is no caller check here, and none is possible: before the first call there is no
    /// principal to check against. What protects it is that a pool is deployed and initialized in a
    /// single transaction, so nothing can act on these contracts in between -- and a second call is
    /// refused.
    fn initialize(
        &mut self,
        factory: &Address,
        token0: &Address,
        token1: &Address,
        lp_token: &Address,
        driver: &Address,
    );

    /// Handle a single swap request, performing the underlying `swap` operations.
    ///
    /// Callable only by this pool's driver. A request names the account whose tokens it spends, and
    /// this contract spends them on that account's standing allowance to it -- so whoever may call
    /// this may spend anyone's allowance. The driver, in turn, takes requests only from the router,
    /// which records the account that actually asked.
    fn handle_request(&mut self, request: SwapRequest);

    /// Claim this block's drain opportunity for the calling crank operation.
    /// Callable only by this pool's driver.
    ///
    /// The driver calls this, commit-locked, before handing the handler any request; of the cranks
    /// in one block, only the first to claim can hold it, and the others abort before attempting to
    /// drain (see `batch_driver::Queue::crank`).
    fn claim_crank(&mut self);

    /// Everything this pool will report about itself.
    #[contract(effect = "readOnly")]
    fn pool_state(&self) -> PoolState;

    /// Send any balance in excess of the recorded reserves to `to`.
    ///
    /// Open to anyone, as a way to recover tokens sent to the pool by mistake.
    fn skim(&mut self, to: &Address);

    /// Record the pool's actual balances as its reserves.
    ///
    /// Open to anyone.
    fn sync(&mut self);
}
