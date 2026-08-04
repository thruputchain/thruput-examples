use super::*;
pub use core::ops::Deref;

// Environment tracked in swap tests
#[derive(Clone)]
pub struct Etx {
    pub env: TestEnvironmentHandle,
    pub ctx: Ctx,
}

impl Etx {
    pub fn advance_block(&self) {
        self.env.advance_block();
    }

    pub fn exec_tx<F, T>(&self, addr: &ContractAddress, f: F) -> Result<T, TransactResult>
    where
        F: Fn() -> T + std::panic::RefUnwindSafe,
    {
        exec_tx(&self.env, addr, f)
    }

    pub fn exec_user_tx<F, T>(&self, user: User, f: F) -> Result<T, TransactResult>
    where
        F: Fn(&User) -> T + std::panic::RefUnwindSafe,
    {
        exec_tx(&self.env, user.addr, || f(&user))
    }

    pub fn user_balances(&self, user: User) -> Result<(Amounts, Amount)> {
        let ctx = &self.ctx;
        self.exec_user_tx(user, |_| ctx.my_balances())
    }

    pub fn user_print_balances(&self, user: User) -> Result<()> {
        let ctx = &self.ctx;
        self.exec_user_tx(user, |_| ctx.user_print_balances(&user))
    }

    pub fn record_stats(&self, users: &[User]) -> Result<SwapStats> {
        let ctx = &self.ctx;

        let get_user_stats = |&u| Ok((u, self.user_balances(u)?));
        let user_stats: UserStats = users
            .iter()
            .map(get_user_stats)
            .collect::<Result<UserStats>>()?;

        let pair_allowances: UserAllows = users
            .iter()
            .map(|&u| Ok((u, self.user_pledges(u)?)))
            .collect::<Result<UserAllows>>()?;

        Ok(SwapStats {
            user_stats,
            swap_pair: self.swap_pair_balances()?,
            pair_allowances,
        })
    }

    pub fn swap_pair_balances(&self) -> Result<(Amounts, Amount)> {
        let ctx = &self.ctx;
        exec_tx(&self.env, &TEST_ADDR, || {
            (
                [
                    ctx.token0().get_balance_of(&ctx.pair_addr),
                    ctx.token1().get_balance_of(&ctx.pair_addr),
                ],
                ctx.lp().get_balance_of(&ctx.pair_addr),
            )
        })
    }

    // What allowances has the user given to the request handler (which is what
    // pulls their tokens when a request is executed)?
    pub fn user_pledges(&self, user: User) -> Result<Amounts> {
        let ctx = &self.ctx;
        exec_tx(&self.env, &TEST_ADDR, || {
            [
                ctx.token0().allowance(user.addr, &ctx.request_handler_addr),
                ctx.token1().allowance(user.addr, &ctx.request_handler_addr),
            ]
        })
    }

    pub fn calculate_swap(&self, amounts_in: Amounts) -> Result<Amounts> {
        let ctx = &self.ctx;

        exec_tx(&self.env, &TEST_ADDR, || ctx.calculate_swap(amounts_in))
    }
}

// Shared liquidity/swap-flow helpers, driven through the router (and driver)
impl Etx {
    // Primer buys liquidity directly from the pair, establishing a price
    pub fn prime(&self) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(PRIMER, |u| ctx.user_buy_unpriced(u))?;
        self.advance_block();

        Ok(())
    }

    pub fn user_add_liquidity(&self, user: User, amounts_desired: Amounts) -> Result<()> {
        let ctx = &self.ctx;

        // Request to buy into the liquidity pool
        self.exec_user_tx(user, |_| {
            // Where the LP tokens go: back to the user
            let recipient = &get_current_address();

            let amounts_min = [0, 0];

            ctx.router().add_liquidity(
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                amounts_desired,
                amounts_min,
                recipient,
            );
        })
    }

    pub fn user_remove_liquidity(
        &self,
        user: User,
        liquidity: Amount,
        amounts_min: Amounts,
    ) -> Result<()> {
        let ctx = &self.ctx;

        // Request to redeem out of the liquidity pool
        self.exec_user_tx(user, |_| {
            // Where the underlying A/B tokens go: back to the user
            let recipient = &get_current_address();

            ctx.router().remove_liquidity(
                &ctx.token_addrs[0],
                &ctx.token_addrs[1],
                liquidity,
                amounts_min,
                recipient,
            );
        })
    }

    // Via the router, swap an exact amount of the token at `in_index` for
    // the other token
    pub fn user_swap_exact_in(
        &self,
        user: User,
        in_index: usize,
        amount_in: Amount,
        amount_out_min: Amount,
    ) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            // Where the output tokens go: back to the user
            let recipient = &get_current_address();

            ctx.router().swap_exact_tokens_for_tokens(
                amount_in,
                amount_out_min,
                &ctx.token_addrs[in_index],
                &ctx.token_addrs[1 - in_index],
                recipient,
            );
        })
    }

    // Via the router, swap the token at `in_index` for an exact amount of
    // the other token
    pub fn user_swap_exact_out(
        &self,
        user: User,
        in_index: usize,
        amount_out: Amount,
        amount_in_max: Amount,
    ) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            // Where the output tokens go: back to the user
            let recipient = &get_current_address();

            ctx.router().swap_tokens_for_exact_tokens(
                amount_out,
                amount_in_max,
                &ctx.token_addrs[in_index],
                &ctx.token_addrs[1 - in_index],
                recipient,
            );
        })
    }

    // Allow the request handler to pull the user's A/B tokens (it moves them to
    // the pair when a request is executed).
    pub fn user_allow_for_pair(&self, user: User, amounts_allowed: Amounts) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            ctx.token0().adjust_allowance(
                &ctx.request_handler_addr,
                amounts_allowed[0].try_into().unwrap(),
            );
            ctx.token1().adjust_allowance(
                &ctx.request_handler_addr,
                amounts_allowed[1].try_into().unwrap(),
            );
        })
    }

    // Allow the request handler to pull the user's LP tokens.
    pub fn user_allow_lp_for_pair(&self, user: User, liquidity: Amount) -> Result<()> {
        let ctx = &self.ctx;

        self.exec_user_tx(user, |_| {
            ctx.lp()
                .adjust_allowance(&ctx.request_handler_addr, liquidity.try_into().unwrap());
        })
    }

    // Process the outstanding requests, returning (n_processed, n_failed).
    pub fn process_requests(&self) -> Result<(u32, u32)> {
        let ctx = &self.ctx;

        self.exec_tx(&TEST_ADDR, || {
            ctx.driver()
                .with_gas_limit(PROCESS_REQUESTS_GAS)
                .process_requests()
        })
    }

    pub fn process_outstanding_requests(&self, n_requests_waiting: u32) -> Result<()> {
        let (n_processed, n_failed) = self.process_requests()?;

        assert_eq!(n_processed, n_requests_waiting);
        assert_eq!(
            0, n_failed,
            "Swap driver: process_requests: Some requests failed"
        );

        println!("Processed {n_processed} requests");
        Ok(())
    }
}

impl Deref for Etx {
    type Target = Ctx;

    fn deref(&self) -> &Ctx {
        &self.ctx
    }
}
