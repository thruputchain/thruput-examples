//! A contract implementing SwapPair

use crate::events::*;
use crate::interface::*;
use crate::reserves::*;
use crate::u256::{U256, mul_div_u128};
use core::cmp::min;
use core::iter::zip;
use core::ops::Mul;
use groundhog_erc20_if::ERC20Client;
use sdk::storage::*;
use sdk::*;
use swap_if::SwapFactoryClient;

/// State for the pair contract
#[storage]
pub struct Pair {
    // Configuration: token (A, B) addresses
    tokens: Value<[Address; 2]>,

    // Configuration: A subsidiary ERC20 contract, implementing the LP token.
    lp_addr: Value<Address>,

    // Configuration: the factory that created this pair.  The pair consults it
    // for the protocol `fee_to` (cf. UniswapV2Pair reading `factory.feeTo()`).
    factory: Value<Address>,

    // State: the reserve product (k) as of the most recent liquidity event,
    // used to compute the protocol fee.  Zero while the fee is disabled.
    k_last: Value<U256>,

    // State
    reserves: Value<Reserves>,
}

#[contract(exports = "swap_exports")]
impl SwapPair for Pair {
    fn initialize(
        &mut self,
        factory: &Address,
        token0: &Address,
        token1: &Address,
        // Deployed but not initialized:
        lp_token: &Address,
    ) {
        if self.lp_addr.try_get().none_if_missing().is_some() {
            throw(SwapPairError::AlreadyInitialized);
        }

        self.lp_addr.set(lp_token);
        self.tokens.set(&[*token0, *token1]);
        self.factory.set(factory);
        self.k_last.set(&U256::ZERO);
        self.reserves.set(&Reserves::new());

        // Adopt the LP contract, initializing it under our control.
        self.lp().initialize(&get_current_address());
    }

    fn liquidity_token(&self) -> ContractAddress {
        self.lp_addr.get()
    }

    fn get_reserves(&self) -> (u128, u128, u32) {
        let r = self.reserves.get();
        let [r0, r1] = r.balances();
        (r0, r1, r.block_timestamp())
    }

    fn get_cumulative_prices(&self) -> [U256; 2] {
        self.reserves.get().cumulative_prices
    }

    fn get_liquidity(&self) -> Amount {
        self.lp().total_supply()
    }

    // Mint LP to `receiver` in exchange for the A/B-tokens `sender` transferred
    fn mint_lp(
        &mut self,
        sender: &Address,
        receiver: &Address,
        request_id: Option<RequestId>,
    ) -> Amount {
        let mut reserves = self.reserves.get();

        // Get the previous snapshot of our reserve balances
        let prev_balances = reserves.balances();

        // Get the current reserve balances, now that the LP has made transfers to us
        let balances = self.get_token_balances();

        // Record the new balances
        reserves.update(balances);
        self.reserves.set(&reserves);

        // Calculate the amounts provided by the user (i.e., the current
        // balances minus the previously-recorded reserve balances).
        let amounts = [
            balances[0].strict_sub(prev_balances[0]),
            balances[1].strict_sub(prev_balances[1]),
        ];

        ensure(
            amounts[0] > 0 && amounts[1] > 0,
            SwapPairError::InsufficientLiquidityMinted,
        );

        let lp = self.lp();

        // Mint the protocol fee (if enabled) on growth since the last liquidity
        // event, using the reserves prior to this deposit.
        let fee_on = self.mint_fee(prev_balances);

        // Read the supply *after* any fee mint
        let lp_total_supply = lp.total_supply();

        let lp_to_create = if lp_total_supply == 0 {
            // Permanently lock the first MINIMUM_LIQUIDITY tokens
            lp.mint(&Self::BLACK_HOLE, Self::MINIMUM_LIQUIDITY);

            let lp: u128 = U256::widening_mul(amounts[0], amounts[1])
                .integer_sqrt()
                .try_into()
                .unwrap();
            lp.strict_sub(Self::MINIMUM_LIQUIDITY)
        } else {
            min(
                mul_div_u128(amounts[0], lp_total_supply, prev_balances[0]),
                mul_div_u128(amounts[1], lp_total_supply, prev_balances[1]),
            )
        };

        ensure(lp_to_create > 0, SwapPairError::InsufficientLiquidityMinted);

        // Mint the new liquidity to the address specified by the LP
        lp.mint(receiver, lp_to_create);
        let lp_minted = lp_to_create;

        // Record k for the next fee computation (reserves are now `balances`).
        if fee_on {
            self.set_k_last(balances);
        }

        log_event(&MintEvent::new(sender, lp_minted, receiver, request_id));

        // Return the amount of liquidity minted
        lp_minted
    }

    // Return pair-tokens in exchange for LP tokens that have been transferred
    // to us
    fn burn_lp(&mut self, to: &Address, request_id: Option<RequestId>) -> Amounts {
        let balances = self.get_token_balances();

        let lp = self.lp();

        // Amount of LP tokens returned to us
        let lp_returned = lp.get_balance();

        // Mint the protocol fee (if enabled) before computing the burn, using
        // the last-recorded reserves.
        let recorded = self.reserves.get().balances();
        let fee_on = self.mint_fee(recorded);

        // Read the supply *after* any fee mint.
        let total_liquidity = lp.total_supply();

        // NOTE: added this check to avoid divide-by-zero below
        ensure(total_liquidity > 0, SwapPairError::NoLiquidityToBurn);

        let amounts = [
            mul_div_u128(lp_returned, balances[0], total_liquidity),
            mul_div_u128(lp_returned, balances[1], total_liquidity),
        ];
        ensure(
            amounts[0] > 0 && amounts[1] > 0,
            SwapPairError::InsufficientLiquidityBurned,
        );

        // Vaporize our LP tokens
        lp.burn(&get_current_address(), lp_returned);

        // Return pair tokens to the user
        self.transfer_to(to, amounts);

        // Update the record of our holdings
        self.sync();

        // Record k for the next fee computation (reserves now reflect the
        // post-burn balances).
        if fee_on {
            self.set_k_last(self.get_token_balances());
        }

        log_event(&BurnEvent::new(&get_caller(), amounts, to, request_id));

        // Return amounts redeemed
        amounts
    }

    fn swap(
        &mut self,
        amount0_out: Amount,
        amount1_out: Amount,
        to: &Address,
        request_id: Option<RequestId>,
    ) {
        let amounts_out = [amount0_out, amount1_out];

        ensure(
            amounts_out[0] > 0 || amounts_out[1] > 0,
            SwapPairError::InsufficientOutputAmount,
        );

        // Get the previous reserve balances
        let mut reserves = self.reserves.get();
        let r = reserves.balances();

        ensure(
            amounts_out[0] < r[0] && amounts_out[1] < r[1],
            SwapPairError::InsufficientLiquidity,
        );

        let addrs = self.token_addrs();
        ensure(
            to != &addrs[0] && to != &addrs[1],
            SwapPairError::InvalidDestination,
        );

        self.transfer_to(to, amounts_out);

        // Optional TODO: Callback for flash-swap goes here.

        // Update the snapshot of reserve balances
        let balances = self.get_token_balances();
        reserves.update(balances);
        self.reserves.set(&reserves);

        // The unchecked subtractions here will not wrap, due to an `ensure` above
        let amounts_in = [
            // cur - (prev - out)
            balances[0].saturating_sub(Amount::from(r[0]) - amounts_out[0]),
            balances[1].saturating_sub(Amount::from(r[1]) - amounts_out[1]),
        ];

        ensure(
            amounts_in[0] > 0 || amounts_in[1] > 0,
            SwapPairError::InsufficientInputAmount,
        );

        let balance_adj = [
            U256::from(balances[0]) * 1000u32 - U256::from(amounts_in[0]) * 3u32,
            U256::from(balances[1]) * 1000u32 - U256::from(amounts_in[1]) * 3u32,
        ];
        let balance_prod = balance_adj[0].mul(balance_adj[1]);
        let reserve_adj = r.map(|b| U256::from(b) * 1000u32);
        let reserve_prod = reserve_adj[0] * reserve_adj[1];
        ensure(
            balance_prod >= reserve_prod,
            SwapPairError::InvalidSwapProduct,
        );

        log_event(&SwapEvent::new(
            &get_caller(),
            amounts_in,
            amounts_out,
            to,
            request_id,
        ));
    }

    // Extract any reserve balances surplus to what was last recorded
    fn skim(&mut self, to: &Address) {
        let reserves = self.reserves.get();
        let prev_balances = reserves.balances();

        let cur_balances = self.get_token_balances();

        let surpluses = [
            cur_balances[0].strict_sub(prev_balances[0]),
            cur_balances[1].strict_sub(prev_balances[1]),
        ];

        self.transfer_to(to, surpluses);
    }

    // Record current reserve balances
    fn sync(&mut self) {
        let balances = self.get_token_balances();
        self.reserves.load_mut().update(balances);
    }
}

// Helper methods
impl Pair {
    pub const MINIMUM_LIQUIDITY: u128 = 1000;
    pub const BLACK_HOLE: Address = Address::zero();

    fn lp(&self) -> ERC20Client {
        ERC20Client::new(&self.lp_addr.get())
    }

    // The protocol-fee recipient, as reported by our factory.
    //
    // (A pair not created by a real factory -- e.g. one deployed directly in a
    // unit test -- reports no fee rather than aborting, so the fee is simply
    // disabled in that case.)
    fn fee_to(&self) -> Option<Address> {
        SwapFactoryClient::new(&self.factory.get())
            .try_fee_to()
            .ok()
            .flatten()
    }

    fn token_addrs(&self) -> [Address; 2] {
        self.tokens.get()
    }

    fn tokens(&self) -> [ERC20Client; 2] {
        self.token_addrs().map(|ref addr| ERC20Client::new(addr))
    }

    // Mint the protocol fee to `fee_to`, if enabled.
    // Returns whether the fee is enabled.
    //
    // The fee is equal to 1/6 of the growth in sqrt(k) since the last
    // liquidity event. `reserves` are the last-recorded reserves (before the
    // current event updates them).
    fn mint_fee(&mut self, reserves: Amounts) -> bool {
        let k_last = self.k_last.get();

        let Some(fee_to) = self.fee_to() else {
            // Fee disabled: clear any stale k so it isn't reused if the fee is
            // later re-enabled.
            if !k_last.is_zero() {
                self.k_last.set(&U256::ZERO);
            }
            return false;
        };

        if !k_last.is_zero() {
            let root_k = U256::widening_mul(reserves[0], reserves[1]).integer_sqrt();
            let root_k_last = k_last.integer_sqrt();

            if root_k > root_k_last {
                let lp = self.lp();
                let total_supply = U256::from(lp.total_supply());

                // liquidity = totalSupply * (rootK - rootKLast)
                //             / (5 * rootK + rootKLast)
                let numerator = total_supply * (root_k - root_k_last);
                let denominator = root_k * 5u32 + root_k_last;
                let liquidity: u128 = (numerator / denominator).try_into().unwrap();

                if liquidity > 0 {
                    lp.mint(&fee_to, liquidity);
                }
            }
        }

        true
    }

    // Record k (= reserve0 * reserve1) as of the given balances, for the next
    // protocol-fee computation.
    fn set_k_last(&mut self, balances: Amounts) {
        self.k_last
            .set(&U256::widening_mul(balances[0], balances[1]));
    }

    // Get our holdings of the A/B tokens
    fn get_token_balances(&self) -> Amounts {
        self.tokens().map(|t| t.get_balance())
    }

    fn transfer_to(&mut self, to: &Address, amounts: Amounts) {
        self.try_transfer_to(to, amounts)
            .unwrap_or_else(|e| throw(e));
    }

    fn try_transfer_to(
        &mut self,
        recipient: &Address,
        amounts: Amounts,
    ) -> Result<(), SwapPairError> {
        for (token, amount) in zip(self.tokens(), amounts) {
            token
                .try_transfer(recipient, amount)
                .map_err(|_| SwapPairError::TransferFailed)?;
        }

        Ok(())
    }
}
