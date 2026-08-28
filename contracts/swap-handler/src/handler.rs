//! The contract implementing SwapRequestHandler

use crate::library::*;
use sdk::storage::*;
use sdk::*;
use swap_if::*;
use swap_pair::Pair;

use SwapRequestError::*;

const A: usize = 0;
const B: usize = 1;

/// State for the request-handler contract
#[storage]
pub struct Handler {
    // State for the swap-pool itself.
    pair: Node<Pair>,
}

#[contract(exports = "swap_handler_exports")]
impl SwapHandler for Handler {
    fn initialize(
        &mut self,
        factory: &Address,
        token0: &Address,
        token1: &Address,
        lp_token: &Address,
    ) {
        // The pair holds the pool's configuration -- the tokens, the LP token,
        // the factory -- and refuses a second initialization itself, so there
        // is nothing for this contract to record.
        self.pair.initialize(factory, token0, token1, lp_token);
    }

    fn liquidity_token(&self) -> ContractAddress {
        self.pair.liquidity_token()
    }

    fn get_reserves(&self) -> (u128, u128, u32) {
        self.pair.get_reserves()
    }

    fn get_liquidity(&self) -> Amount {
        self.pair.get_liquidity()
    }

    fn get_cumulative_prices(&self) -> [U256; 2] {
        self.pair.get_cumulative_prices()
    }

    fn skim(&mut self, to: &Address) {
        self.pair.skim(to);
    }

    fn sync(&mut self) {
        self.pair.sync();
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
        let (reserve_a, reserve_b, _) = self.pair.get_reserves();

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

        // Take the purchaser's tokens into the pool, then mint LP to the
        // recipient.
        self.transfer_amounts_from(&req.purchaser, amounts);
        let minted = self.pair.mint_lp(&req.recipient);

        log_event(&MintEvent::new(
            &req.purchaser,
            minted,
            &req.recipient,
            Some(request_id),
        ));
    }

    // Burn LP tokens, computing the recovered amounts from live reserves.
    fn handle_remove_liquidity(&mut self, req: RemoveLiquidityRequest, request_id: RequestId) {
        let (reserve_a, reserve_b, _) = self.pair.get_reserves();
        let total_supply = self.pair.get_liquidity();

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

        // Take the redeemer's LP tokens into the pool, then burn them out to
        // the recipient.
        self.transfer_lp_from(&req.redeemer, req.liquidity);
        let redeemed = self.pair.burn_lp(&req.recipient);

        log_event(&BurnEvent::new(
            &req.redeemer,
            redeemed,
            &req.recipient,
            Some(request_id),
        ));
    }

    // Swap an exact input amount for as much output as possible.
    fn handle_swap_exact_in(&mut self, req: SwapExactInRequest, request_id: RequestId) {
        let in_index = req.in_index as usize;
        let out_index = 1 - in_index;

        let (reserve0, reserve1, _) = self.pair.get_reserves();
        let reserves = [reserve0, reserve1];

        let amount_out = get_amount_out(req.amount_in, [reserves[in_index], reserves[out_index]]);
        ensure(amount_out >= req.amount_out_min, InsufficientOutputAmount);

        let mut amounts_in: Amounts = [0, 0];
        amounts_in[in_index] = req.amount_in;

        let mut amounts_out: Amounts = [0, 0];
        amounts_out[out_index] = amount_out;

        self.transfer_amounts_from(&req.trader, amounts_in);
        let amounts_in = self
            .pair
            .swap(amounts_out[0], amounts_out[1], &req.recipient);

        log_event(&SwapEvent::new(
            &req.trader,
            amounts_in,
            amounts_out,
            &req.recipient,
            Some(request_id),
        ));
    }

    // Swap as little input as possible for an exact output amount.
    fn handle_swap_exact_out(&mut self, req: SwapExactOutRequest, request_id: RequestId) {
        let in_index = req.in_index as usize;
        let out_index = 1 - in_index;

        let (reserve0, reserve1, _) = self.pair.get_reserves();
        let reserves = [reserve0, reserve1];

        let amount_in = get_amount_in(req.amount_out, [reserves[in_index], reserves[out_index]]);
        ensure(amount_in <= req.amount_in_max, ExcessiveInputAmount);

        let mut amounts_in: Amounts = [0, 0];
        amounts_in[in_index] = amount_in;

        let mut amounts_out: Amounts = [0, 0];
        amounts_out[out_index] = req.amount_out;

        self.transfer_amounts_from(&req.trader, amounts_in);
        let amounts_in = self
            .pair
            .swap(amounts_out[0], amounts_out[1], &req.recipient);

        log_event(&SwapEvent::new(
            &req.trader,
            amounts_in,
            amounts_out,
            &req.recipient,
            Some(request_id),
        ));
    }

    // Transfer helpers
    //
    // The user grants their allowance to this contract, which is also where
    // the pool's tokens sit -- so a deposit is a transfer to here, and the
    // pair's balance-delta accounting reads this contract's balances.

    fn transfer_amounts_from(&self, owner: &Address, amounts: Amounts) {
        let to = get_current_address();
        let tokens = self.pair.tokens();

        for i in 0..=1 {
            if amounts[i] > 0 {
                tokens[i].transfer_from(owner, &to, amounts[i]);
            }
        }
    }

    fn transfer_lp_from(&self, owner: &Address, amount: Amount) {
        // Transfer `amount` of the owner's LP tokens to the pair
        self.pair
            .lp()
            .transfer_from(owner, &get_current_address(), amount);
    }
}

/// The pool's pair state, as this contract stores it.
///
/// For tests that drive the pair directly, in a frame at the handler's own
/// address.
#[cfg(feature = "dev")]
pub fn pair_state() -> Node<Pair> {
    use sdk::storage::{Keypath, StorageDomain};

    // The same root the contract's own state is built from: a `#[storage]`
    // struct is rooted at a domain derived from its name.
    let handler: Handler = Keypath::root(<Handler as StorageDomain>::DOMAIN).into();
    handler.pair
}
