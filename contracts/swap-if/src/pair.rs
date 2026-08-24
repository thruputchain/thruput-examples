//! The fundamental swap-pair operations (cf. UniswapV2Pair).

use crate::{
    Address, Amount, Amounts, BurnEvent, ERC20Error, MintEvent, RequestId, SwapEvent, SyncEvent,
    U256,
};
use core::fmt;
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
    /// An operation that attributes its effects was called by someone other
    /// than this pair's handler.  See [`SwapPair`].
    Unauthorized = 14,
}

impl fmt::Display for SwapPairError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SwapV2{:?}", self)
    }
}

#[contract(
    client = SwapPairClient,
    throws(SwapPairError, ERC20Error),
    emits(MintEvent, BurnEvent, SwapEvent, SyncEvent)
)]
pub trait SwapPair {
    /// Must be called exactly once before any other methods
    ///
    /// `handler` is the only address allowed to call the operations that
    /// attribute their effects -- [`mint_lp`](Self::mint_lp),
    /// [`burn_lp`](Self::burn_lp) and [`swap`](Self::swap).  Each of those
    /// takes the `sender` it should credit as an argument, so the pair cannot
    /// check it: whoever may call them can name anyone as the sender, and can
    /// stamp any [`RequestId`] onto the event.  Restricting them to the
    /// handler is what makes the resulting events trustworthy -- the handler
    /// passes on the sender the router recorded from the actual caller.
    ///
    /// This is a departure from UniswapV2, where a pair's `swap` is open to
    /// anyone.  Here every operation is meant to arrive through the request
    /// queue, which is what lets a pair serve many of them in one block.
    fn initialize(
        &mut self,
        factory: &Address,
        token0: &Address,
        token1: &Address,
        // A deployed but *uninitialized* ERC20 token contract.  This method
        // adopts it as the LP token and initializes it under the pair's
        // control.
        lp_token: &Address,
        handler: &Address,
    );

    fn liquidity_token(&self) -> ContractAddress;

    fn get_reserves(&self) -> (u128, u128, u32);
    fn get_liquidity(&self) -> Amount;
    /// The last-recorded cumulative prices, as UQ112x112 fixed-point values
    /// (`[price0, price1]`), for use as a time-weighted-average-price oracle.
    fn get_cumulative_prices(&self) -> [U256; 2];

    /// Mint LP tokens to `recipient`, in exchange for the tokens `sender`
    /// deposited into this pair.
    ///
    /// The amount minted is derived from the pair's own balance delta, so
    /// `sender` does not affect it: it names the depositor for the event, and
    /// the caller is responsible for it being the account whose tokens
    /// actually arrived.
    ///
    /// `request_id` tags the resulting [`MintEvent`].
    ///
    /// Callable only by the handler (see [`initialize`](Self::initialize)):
    /// `sender` and `request_id` are taken on trust, so whoever may call this
    /// can attribute its effects to anyone.
    fn mint_lp(
        &mut self,
        sender: &Address,
        recipient: &Address,
        request_id: Option<RequestId>,
    ) -> Amount;

    /// Burn the LP tokens `sender` deposited into this pair, sending the
    /// proceeds to `recipient`.
    ///
    /// The amounts are derived from the LP balance actually deposited, so
    /// `sender` names the source of the LP tokens rather than determining the
    /// outcome.
    ///
    /// `request_id` tags the resulting [`BurnEvent`].
    ///
    /// Callable only by the handler (see [`initialize`](Self::initialize)):
    /// `sender` and `request_id` are taken on trust, so whoever may call this
    /// can attribute its effects to anyone.
    fn burn_lp(
        &mut self,
        sender: &Address,
        recipient: &Address,
        request_id: Option<RequestId>,
    ) -> Amounts;

    /// Send any balance in excess of the recorded reserves to `to`.
    ///
    /// Open to anyone, as in UniswapV2: it attributes nothing and can only
    /// move what the reserves do not account for, so it stays available as a
    /// way to recover tokens sent to the pair by mistake.
    fn skim(&mut self, to: &Address);

    /// Record the pair's actual balances as its reserves.
    ///
    /// Open to anyone, for the same reason as [`skim`](Self::skim): its event
    /// carries reserves and no attribution.
    fn sync(&mut self);

    /// Swap out the given amounts to `recipient`, against the input amounts
    /// `sender` paid into this pair.
    ///
    /// The input amounts are derived from the pair's own balance delta, so
    /// `sender` names the trader for the event rather than determining the
    /// outcome.
    ///
    /// `request_id` tags the resulting [`SwapEvent`].
    ///
    /// Callable only by the handler (see [`initialize`](Self::initialize)):
    /// `sender` and `request_id` are taken on trust, so whoever may call this
    /// can attribute its effects to anyone.
    fn swap(
        &mut self,
        amount0_out: Amount,
        amount1_out: Amount,
        sender: &Address,
        recipient: &Address,
        request_id: Option<RequestId>,
    );
}
