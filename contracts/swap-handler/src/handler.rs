//! The contract implementing SwapRequestHandler

use crate::cfg::*;
use crate::library::*;
use sdk::storage::*;
use sdk::*;
use swap_if::*;

use SwapRequestError::*;

const A: usize = 0;
const B: usize = 1;

/// State for the request-handler contract
#[storage]
pub struct Handler {
    // Configuration
    cfg: Value<Cfg>,
}

#[contract(exports = "swap_handler_exports")]
impl SwapHandler for Handler {
    fn initialize(&mut self, swap_pair: &Address, token0: &Address, token1: &Address) {
        if self.cfg.try_get().none_if_missing().is_some() {
            panic!("Already initialized.");
        }

        // The LP token is owned by the pair; ask it.
        let lp_token = SwapPairClient::new(swap_pair).liquidity_token();

        let cfg = Cfg {
            swap_pair: *swap_pair,
            tokens: [*token0, *token1],
            lp_token,
        };

        self.cfg.set(&cfg);
    }

    fn handle_request(&mut self, request: SwapRequest) {
        let request_id = request.request_id;
        match request.op {
            SwapOp::AddLiquidity(req) => self.handle_add_liquidity(req, request_id),
            SwapOp::RemoveLiquidity(req) => self.handle_remove_liquidity(req, request_id),
            SwapOp::SwapExactIn(req) => self.handle_swap_exact_in(req, request_id),
            SwapOp::SwapExactOut(req) => self.handle_swap_exact_out(req, request_id),
        }
    }
}

impl Handler {
    // Provide liquidity, computing the optimal A/B ratio from live reserves.
    fn handle_add_liquidity(&mut self, req: AddLiquidityRequest, request_id: RequestId) {
        let cfg = self.cfg.get();
        let pair = cfg.pair();

        let (reserve_a, reserve_b, _) = pair.get_reserves();

        let amounts: Amounts = if reserve_a == 0 && reserve_b == 0 {
            req.amounts_desired
        } else {
            let amount_optimal_b = quote(req.amounts_desired[A], [reserve_a, reserve_b]);

            if amount_optimal_b <= req.amounts_desired[B] {
                ensure(amount_optimal_b >= req.amounts_min[B], InsufficientAmountA);
                [req.amounts_desired[A], amount_optimal_b]
            } else {
                let amount_optimal_a = quote(req.amounts_desired[B], [reserve_b, reserve_a]);
                assert!(amount_optimal_a <= req.amounts_desired[A]);
                ensure(amount_optimal_a >= req.amounts_min[A], InsufficientAmountB);
                [amount_optimal_a, req.amounts_desired[B]]
            }
        };

        // Move the purchaser's tokens to the pair, then mint LP to the
        // recipient.  The two may differ, so the pair is told both: it credits
        // the recipient and reports the purchaser as the depositor.
        self.transfer_amounts_from(&req.purchaser, amounts);
        let _minted = pair.mint_lp(&req.purchaser, &req.recipient, Some(request_id));
    }

    // Burn LP tokens, computing the recovered amounts from live reserves.
    fn handle_remove_liquidity(&mut self, req: RemoveLiquidityRequest, request_id: RequestId) {
        let cfg = self.cfg.get();
        let pair = cfg.pair();

        let (reserve_a, reserve_b, _) = pair.get_reserves();
        let total_supply = pair.get_liquidity();

        // The amounts that burning `liquidity` LP tokens will return, mirroring
        // `burn_lp`: amount_i = liquidity * reserve_i / total_supply.
        let amounts: Amounts = [
            ((U256::from(req.liquidity) * U256::from(reserve_a)) / U256::from(total_supply))
                .try_into()
                .unwrap(),
            ((U256::from(req.liquidity) * U256::from(reserve_b)) / U256::from(total_supply))
                .try_into()
                .unwrap(),
        ];

        ensure(amounts[A] >= req.amounts_min[A], InsufficientAmountA);
        ensure(amounts[B] >= req.amounts_min[B], InsufficientAmountB);

        // Move the redeemer's LP tokens to the pair, then burn them to the
        // recipient.  The two may differ, so the pair is told both: it pays out
        // to the recipient and reports the redeemer as the source.
        self.transfer_lp_from(&req.redeemer, req.liquidity);
        let _redeemed = pair.burn_lp(&req.redeemer, &req.recipient, Some(request_id));
    }

    // Swap an exact input amount for as much output as possible.
    fn handle_swap_exact_in(&mut self, req: SwapExactInRequest, request_id: RequestId) {
        let cfg = self.cfg.get();
        let pair = cfg.pair();

        let in_index = req.in_index as usize;
        let out_index = 1 - in_index;

        let (reserve0, reserve1, _) = pair.get_reserves();
        let reserves = [reserve0, reserve1];

        let amount_out = get_amount_out(req.amount_in, [reserves[in_index], reserves[out_index]]);
        ensure(amount_out >= req.amount_out_min, InsufficientOutputAmount);

        let mut amounts_in: Amounts = [0, 0];
        amounts_in[in_index] = req.amount_in;

        let mut amounts_out: Amounts = [0, 0];
        amounts_out[out_index] = amount_out;

        // As with the liquidity operations, the trader paying the input and the
        // recipient of the proceeds may differ, so the pair is told both.
        self.transfer_amounts_from(&req.trader, amounts_in);
        pair.swap(
            amounts_out[0],
            amounts_out[1],
            &req.trader,
            &req.recipient,
            Some(request_id),
        );
    }

    // Swap as little input as possible for an exact output amount.
    fn handle_swap_exact_out(&mut self, req: SwapExactOutRequest, request_id: RequestId) {
        let cfg = self.cfg.get();
        let pair = cfg.pair();

        let in_index = req.in_index as usize;
        let out_index = 1 - in_index;

        let (reserve0, reserve1, _) = pair.get_reserves();
        let reserves = [reserve0, reserve1];

        let amount_in = get_amount_in(req.amount_out, [reserves[in_index], reserves[out_index]]);
        ensure(amount_in <= req.amount_in_max, ExcessiveInputAmount);

        let mut amounts_in: Amounts = [0, 0];
        amounts_in[in_index] = amount_in;

        let mut amounts_out: Amounts = [0, 0];
        amounts_out[out_index] = req.amount_out;

        self.transfer_amounts_from(&req.trader, amounts_in);
        pair.swap(
            amounts_out[0],
            amounts_out[1],
            &req.trader,
            &req.recipient,
            Some(request_id),
        );
    }

    // Transfer helpers
    //
    // The user grants their allowance to this contract, which moves the tokens
    // into the pair before invoking the pair's core operations.

    fn transfer_amounts_from(&self, owner: &Address, amounts: Amounts) {
        let cfg = self.cfg.get();
        let to = cfg.swap_pair;
        let tokens = cfg.tokens();

        for i in 0..=1 {
            if amounts[i] > 0 {
                tokens[i].transfer_from(owner, &to, amounts[i]);
            }
        }
    }

    fn transfer_lp_from(&self, owner: &Address, amount: Amount) {
        let cfg = self.cfg.get();

        // Transfer `amount` of the owner's LP tokens to the pair
        cfg.lp().transfer_from(owner, &cfg.swap_pair, amount);
    }
}
