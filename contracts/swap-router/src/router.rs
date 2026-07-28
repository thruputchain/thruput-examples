//! A request router for the example contracts `swap` and `swap_driver`
//!
//! The router translates high-level user operations into [`SwapRequest`]s and
//! enqueues them with the driver.  It performs no price calculation itself:
//! the optimizing math happens when requests are dequeued and performed.

use crate::cfg::*;
use sdk::storage::*;
use sdk::*;
use swap_if::*;

#[storage]
pub struct Router {
    // Configuration
    cfg: Value<Cfg>,
}

#[contract(exports = "swap_router_exports")]
impl SwapRouter for Router {
    // Initialize the router with the factory it resolves pairs through.  The
    // factory creates a pair's suite on first use (see `Cfg::get_pair`).
    fn initialize(&mut self, factory: &Address) {
        if self.cfg.try_get().none_if_missing().is_some() {
            panic!("Already initialized.");
        }

        self.cfg.set(&Cfg { factory: *factory });
    }

    // Request to provide liquidity, receiving LP tokens in return.
    //
    // The optimal A/B ratio (within `amounts_min`) is computed when the request
    // is executed.  Before calling, the user must give the request-handler the
    // needed allowances of tokens A/B (typically `amounts_desired`).
    fn add_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        amounts_desired: Amounts,
        amounts_min: Amounts,
        recipient: &Address,
    ) {
        let cfg = self.cfg.get();
        // `addLiquidity` is the one entry point that creates the pair on first use.
        let driver = cfg.get_or_create_pair(token_a, token_b);

        let purchaser = get_caller();
        driver.request(SwapRequest::add_liquidity(
            &purchaser,
            amounts_desired,
            amounts_min,
            recipient,
        ));
    }

    // Request to burn `liquidity` LP tokens, returning the underlying A/B
    // tokens to `recipient` (but no less than `amounts_min` of each, checked at
    // execution time).
    //
    // Before calling, the user must give the request-handler an allowance of at
    // least `liquidity` LP tokens.
    fn remove_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        liquidity: Amount,
        amounts_min: Amounts,
        recipient: &Address,
    ) {
        let cfg = self.cfg.get();
        let driver = cfg.get_pair(token_a, token_b);

        let redeemer = get_caller();
        driver.request(SwapRequest::remove_liquidity(
            &redeemer,
            liquidity,
            amounts_min,
            recipient,
        ));
    }

    /// Request to swap an exact amount of the input token for as much of the
    /// output token as possible (but no less than `amount_out_min`, checked at
    /// execution time).
    ///
    /// Before calling, the user must give the request-handler an allowance of
    /// at least `amount_in` of the input token.
    ///
    fn swap_exact_tokens_for_tokens(
        &self,
        amount_in: Amount,
        amount_out_min: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    ) {
        let cfg = self.cfg.get();
        let (driver, in_index) = cfg.get_pair_directed(token_in, token_out);

        let trader = get_caller();
        driver.request(SwapRequest::swap_exact_in(
            &trader,
            amount_in,
            amount_out_min,
            in_index as u32,
            recipient,
        ));
    }

    // Request to swap as little of the input token as possible (but no more
    // than `amount_in_max`, checked at execution time) for an exact amount of
    // the output token.
    //
    // Before calling, the user must give the request-handler an allowance of at
    // least `amount_in_max` of the input token.  (Only the amount actually
    // needed is consumed.)
    fn swap_tokens_for_exact_tokens(
        &self,
        amount_out: Amount,
        amount_in_max: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    ) {
        let cfg = self.cfg.get();
        let (driver, in_index) = cfg.get_pair_directed(token_in, token_out);

        let trader = get_caller();
        driver.request(SwapRequest::swap_exact_out(
            &trader,
            amount_out,
            amount_in_max,
            in_index as u32,
            recipient,
        ));
    }
}
