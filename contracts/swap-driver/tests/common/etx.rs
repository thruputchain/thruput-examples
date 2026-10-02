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

    /// Run `op` as the pool, in a frame at the handler's address -- which is where the pair's state
    /// and tokens live.
    pub fn exec_as_pair<F, T>(&self, op: F) -> Result<T, TransactResult>
    where
        F: Fn(&mut Node<Pair>) -> T + std::panic::RefUnwindSafe,
    {
        let addr = self.ctx.request_handler_addr;
        exec_tx(&self.env, &addr, || {
            let mut pair = swap_handler::pair_state();
            op(&mut pair)
        })
    }

    /// Run `deposit` as `user` and then `op` as the pool, in *one* transaction, so that the
    /// operation sees the deposit. (A second transaction would read the balances its own block
    /// began with.)
    pub fn exec_depositing_as_pair<D, F, T>(
        &self,
        user: User,
        deposit: D,
        op: F,
    ) -> Result<T, TransactResult>
    where
        D: Fn(&User) + std::panic::RefUnwindSafe,
        F: Fn(&mut Node<Pair>) -> T + std::panic::RefUnwindSafe,
    {
        use std::sync::{Arc, Mutex};

        let addr = self.ctx.request_handler_addr;
        let out: Arc<Mutex<Option<T>>> = Arc::new(Mutex::new(None));

        let r = self.env.transact(|tx| {
            tx.call(user.addr)
                .run_continuable(|frame| {
                    deposit(&user);

                    frame
                        .child_call(&addr)
                        .run(|| {
                            let mut pair = swap_handler::pair_state();
                            *Arc::clone(&out).lock().unwrap() = Some(op(&mut pair));
                        })
                        .assert_success();

                    FrameAction::Close
                })
                .finish()
        });

        let out = Arc::into_inner(out)
            .unwrap()
            .into_inner()
            .unwrap_or_else(|e| e.into_inner());

        if r.is_success() {
            Ok(out.unwrap())
        } else {
            Err(r)
        }
    }

    // Provide AB-token liquidity in exchange for LP tokens. Deposit and mint share a transaction,
    // so the mint sees the deposit.
    pub fn user_buy_unpriced(&self, user: User) -> Result<()> {
        let ctx = self.ctx;
        let minted = self.exec_depositing_as_pair(
            user,
            |u| ctx.user_buy_unpriced(u),
            move |pair| pair.mint_lp(user.addr),
        )?;
        println!("> {} bought {:.3} LP", user.name, decimalized(minted));
        self.user_print_balances(user)
    }

    pub fn user_buy(&self, user: User) -> Result<()> {
        let ctx = self.ctx;
        let minted = self.exec_depositing_as_pair(
            user,
            |u| ctx.user_buy(u),
            move |pair| pair.mint_lp(user.addr),
        )?;
        println!("> {} bought {:.3} LP", user.name, decimalized(minted));
        self.user_print_balances(user)
    }

    pub fn user_redeem(&self, user: User) -> Result<()> {
        let ctx = self.ctx;
        self.exec_depositing_as_pair(
            user,
            |u| ctx.user_redeem(u),
            move |pair| pair.burn_lp(user.addr),
        )?;
        self.user_print_balances(user)
    }

    pub fn user_balances(&self, user: User) -> Result<(Amounts, Amount)> {
        let ctx = &self.ctx;
        self.exec_user_tx(user, |_| ctx.my_balances())
    }

    pub fn user_print_balances(&self, user: User) -> Result<()> {
        let ctx = &self.ctx;
        self.exec_user_tx(user, |_| ctx.user_print_balances(&user))
    }

    pub fn record_stats(&self, user_a: User, user_b: User) -> Result<SwapStats> {
        Ok(SwapStats {
            user_a: (user_a, self.user_balances(user_a)?),
            user_b: (user_b, self.user_balances(user_b)?),
            swap_pair: self.swap_pair_balances()?,
        })
    }

    pub fn swap_pair_balances(&self) -> Result<(Amounts, Amount)> {
        let ctx = &self.ctx;
        exec_tx(&self.env, &TEST_ADDR, || {
            (
                [
                    from_token(ctx.token0().get_balance_of(&ctx.request_handler_addr)),
                    from_token(ctx.token1().get_balance_of(&ctx.request_handler_addr)),
                ],
                from_token(ctx.lp().get_balance_of(&ctx.request_handler_addr)),
            )
        })
    }

    // What allowances has the user given to the request handler?
    pub fn user_pledges(&self, user: User) -> Result<Amounts> {
        let ctx = &self.ctx;
        exec_tx(&self.env, &TEST_ADDR, || {
            [
                from_token(ctx.token0().allowance(user.addr, &ctx.request_handler_addr)),
                from_token(ctx.token1().allowance(user.addr, &ctx.request_handler_addr)),
            ]
        })
    }

    pub fn calculate_swap(&self, amounts_in: Amounts) -> Result<Amounts> {
        let ctx = &self.ctx;

        exec_tx(&self.env, &TEST_ADDR, || ctx.calculate_swap(amounts_in))
    }

    pub fn process_requests(&self) -> Result<(u32, u32)> {
        let ctx = &self.ctx;

        exec_tx(&self.env, &TEST_ADDR, || {
            ctx.driver()
                .with_gas_limit(process_requests_gas(10))
                .process_requests()
        })
    }
}

impl Deref for Etx {
    type Target = Ctx;

    fn deref(&self) -> &Ctx {
        &self.ctx
    }
}
