//! A contract implementing SwapPair

use crate::events::*;
use crate::interface::*;
use crate::reserves::*;
use crate::u256::U256;
use core::cmp::min;
use core::iter::zip;
use core::ops::Mul;
use groundhog_erc20_if::ERC20Client;
use sdk::storage::*;
use sdk::*;

/// State for the pair contract
#[storage]
pub struct Pair {
    // Configuration: token (A, B) addresses
    tokens: Value<[Address; 2]>,

    // Configuration: A subsidiary ERC20 contract, implementing the LP token.
    lp_addr: Value<Address>,

    // State
    reserves: Value<Reserves>,
}

#[contract(exports = "swap_exports")]
impl SwapPair for Pair {
    fn initialize(
        &mut self,
        _factory: &Address,
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

    // Mint LP in exchange for any A/B-tokens transferred
    fn mint_lp(&mut self, to: &Address) -> Amount {
        let mut reserves = self.reserves.get();

        // Get the previous snapshot of our reserve balances
        let prev_balances = reserves.balances();

        // Get the current reserve balances, now that the LP has made transfers to us
        let balances = self._get_token_balances();

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
        let lp_total_supply = lp.total_supply();

        let lp_to_create = if lp_total_supply == 0 {
            // Permanently lock the first MINIMUM_LIQUIDITY tokens
            lp.mint(&Self::BLACK_HOLE, Self::MINIMUM_LIQUIDITY);

            let lp: u128 = (U256::from(amounts[0]) * U256::from(amounts[1]))
                .integer_sqrt()
                .try_into()
                .unwrap();
            lp.strict_sub(Self::MINIMUM_LIQUIDITY)
        } else {
            min(
                (U256::from(amounts[0]) * U256::from(lp_total_supply))
                    / U256::from(prev_balances[0]),
                (U256::from(amounts[1]) * U256::from(lp_total_supply))
                    / U256::from(prev_balances[1]),
            )
            .try_into()
            .unwrap()
        };

        ensure(lp_to_create > 0, SwapPairError::InsufficientLiquidityMinted);

        // Mint the new liquidity to the address specified by the LP
        lp.mint(to, lp_to_create);
        let lp_minted = lp_to_create;

        log_event(&MintEvent::new(&get_caller(), lp_minted));

        // Return the amount of liquidity minted
        lp_minted
    }

    // Return pair-tokens in exchange for LP tokens that have been transferred
    // to us
    fn burn_lp(&mut self, to: &Address) -> Amounts {
        let balances = self._get_token_balances();

        let lp = self.lp();

        // Amount of LP tokens returned to us
        let lp_returned = lp.get_balance();

        let total_liquidity = lp.total_supply();

        // NOTE: added this check to avoid divide-by-zero below
        ensure(total_liquidity > 0, SwapPairError::NoLiquidityToBurn);

        let amounts = [
            lp_returned.strict_mul(balances[0]) / total_liquidity,
            lp_returned.strict_mul(balances[1]) / total_liquidity,
        ];
        ensure(
            amounts[0] > 0 && amounts[1] > 0,
            SwapPairError::InsufficientLiquidityBurned,
        );

        // Vaporize our LP tokens
        lp.burn(&get_current_address(), lp_returned);

        // Return pair tokens to the user
        self._transfer_to(to, amounts);

        // Update the record of our holdings
        self.sync();

        log_event(&BurnEvent::new(&get_caller(), amounts, to));

        // Return amounts redeemed
        amounts
    }

    fn swap(&mut self, amount0_out: Amount, amount1_out: Amount, to: &Address) {
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

        self._transfer_to(to, amounts_out);

        // Optional TODO: Callback for flash-swap goes here.

        // Update the snapshot of reserve balances
        let balances = self._get_token_balances();
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
            U256::from(balances[0]) * U256::from(1000) - U256::from(amounts_in[0]) * U256::from(3),
            U256::from(balances[1]) * U256::from(1000) - U256::from(amounts_in[1]) * U256::from(3),
        ];
        let balance_prod = balance_adj[0].mul(balance_adj[1]);
        let reserve_adj = r.map(|b| U256::from(b) * U256::from(1000));
        let reserve_prod = reserve_adj[0] * reserve_adj[1];
        ensure(
            balance_prod >= reserve_prod,
            SwapPairError::InvalidSwapProduct,
        );

        log_event(&SwapEvent::new(&get_caller(), amounts_in, amounts_out, to));
    }

    // Extract any reserve balances surplus to what was last recorded
    fn skim(&mut self, to: &Address) {
        let reserves = self.reserves.get();
        let prev_balances = reserves.balances();

        let cur_balances = self._get_token_balances();

        let surpluses = [
            cur_balances[0].strict_sub(prev_balances[0]),
            cur_balances[1].strict_sub(prev_balances[1]),
        ];

        self._transfer_to(to, surpluses);
    }

    // Record current reserve balances
    fn sync(&mut self) {
        let balances = self._get_token_balances();
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

    fn token_addrs(&self) -> [Address; 2] {
        self.tokens.get()
    }

    fn tokens(&self) -> [ERC20Client; 2] {
        self.token_addrs().map(|ref addr| ERC20Client::new(addr))
    }

    fn _mint_fee(&mut self) -> bool {
        // Optional TODO: support fee_to setting

        false
    }

    // Get our holdings of the A/B tokens
    fn _get_token_balances(&self) -> Amounts {
        self.tokens().map(|t| t.get_balance())
    }

    fn _transfer_to(&mut self, to: &Address, amounts: Amounts) {
        self._try_transfer_to(to, amounts)
            .unwrap_or_else(|e| throw(e));
    }

    fn _try_transfer_to(
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

    fn _transfer_from(&mut self, from: &Address, amounts: Amounts) {
        self._try_transfer_from(from, amounts)
            .unwrap_or_else(|e| throw(e));
    }

    fn _try_transfer_from(
        &mut self,
        from: &Address,
        amounts: Amounts,
    ) -> Result<(), SwapPairError> {
        let me = get_current_address();

        for (token, amount) in zip(self.tokens(), amounts) {
            token
                .try_transfer_from(from, &me, amount)
                .map_err(|_| SwapPairError::TransferFailed)?;
        }

        Ok(())
    }
}
