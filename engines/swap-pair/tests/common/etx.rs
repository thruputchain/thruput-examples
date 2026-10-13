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
        exec_tx2(&self.env, addr, f, event_handler)
    }

    pub fn exec_user_tx<F, T>(&self, user: User, f: F) -> Result<T, TransactResult>
    where
        F: Fn(&User) -> T + std::panic::RefUnwindSafe,
    {
        self.exec_tx(user.addr, || f(&user))
    }

    /// Run `op` as the pair, in a frame at the pair's own address.
    pub fn exec_as_pair<F, T>(&self, op: F) -> Result<T, TransactResult>
    where
        F: Fn(&mut Node<Pair>) -> T + std::panic::RefUnwindSafe,
    {
        self.exec_tx(&PAIR_ADDR, || {
            let mut pair: Node<Pair> = Keypath::default().into();
            op(&mut pair)
        })
    }

    /// Run `deposit` as `user` and then `op` as the pair, in *one*
    /// transaction.
    ///
    /// This is how the pair is really used: its caller moves tokens into it
    /// and then performs an operation against the balance that resulted.  A
    /// child frame keeps the two in the same transaction, so the operation
    /// sees the deposit -- which a second transaction would not, reading as it
    /// would the balances its own block began with.
    pub fn exec_depositing_as_pair<D, F, T>(
        &self,
        user: User,
        deposit: D,
        op: F,
    ) -> Result<T, TransactResult>
    where
        D: Fn(&User) + std::panic::RefUnwindSafe,
        F: Fn(&mut Node<Pair>) -> T + std::panic::RefUnwindSafe,
        T: xdr::WriteXDR + xdr::ReadXDROwned,
    {
        use std::sync::{Arc, Mutex};

        let out: Arc<Mutex<Option<T>>> = Arc::new(Mutex::new(None));

        let r = self.env.transact(|tx| {
            tx.call(user.addr)
                .run_continuable(|frame| {
                    deposit(&user);

                    frame
                        .child_call(&PAIR_ADDR)
                        .run(|| {
                            let mut pair: Node<Pair> = Keypath::default().into();
                            *Arc::clone(&out).lock().unwrap() = Some(op(&mut pair));
                        })
                        .assert_success();

                    FrameAction::Close
                })
                .finish()
        });

        if r.is_success() {
            Ok(Arc::into_inner(out).unwrap().into_inner().unwrap().unwrap())
        } else {
            Err(r)
        }
    }

    // Provide AB-token liquidity in exchange for LP tokens.
    pub fn user_buy(&self, user: User) -> Result<(), TransactResult> {
        let ctx = self.ctx;
        let minted = self.exec_depositing_as_pair(
            user,
            |u| ctx.user_deposit_tokens(u),
            move |pair| pair.mint_lp(user.addr),
        )?;
        println!("> {} bought {:.3} LP", user.name, decimalized(minted));
        self.user_print_balances(user)
    }

    // Redeem LP tokens for the underlying pair tokens.
    pub fn user_redeem(&self, user: User) -> Result<(), TransactResult> {
        let ctx = self.ctx;
        self.exec_depositing_as_pair(
            user,
            |u| ctx.user_deposit_lp(u),
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
        print_balances(user.name, self.user_balances(user)?);
        Ok(())
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
                    from_token(ctx.token0().get_balance_of(&ctx.pair_addr)),
                    from_token(ctx.token1().get_balance_of(&ctx.pair_addr)),
                ],
                from_token(ctx.lp().get_balance_of(&ctx.pair_addr)),
            )
        })
    }

    // What allowances has the user given to the pair contract?
    pub fn user_pledges(&self, user: User) -> Result<Amounts> {
        let ctx = &self.ctx;
        exec_tx(&self.env, &TEST_ADDR, || {
            [
                from_token(ctx.token0().allowance(user.addr, &ctx.pair_addr)),
                from_token(ctx.token1().allowance(user.addr, &ctx.pair_addr)),
            ]
        })
    }
}

impl Deref for Etx {
    type Target = Ctx;

    fn deref(&self) -> &Ctx {
        &self.ctx
    }
}

fn event_handler(e: &sdk::types::event::TxEmittedEvent) {
    use swap_pair::events::*;
    use thruput_erc20_if as erc20;

    let e: EmittedEvent = e.into();

    let Some(topic0) = e.topic(0) else {
        println!("EEE <Unknown>");
        return;
    };

    match topic0 {
        erc20::TransferEvent::SIGNATURE => {
            let e: TypedEvent<erc20::TransferEvent> = TypedEvent::new(e.raw());
            let amount = e.payload().amount;

            println!("EEE Transfer {}", amount);
        }
        LiquidityMintEvent::SIGNATURE => {
            let e: TypedEvent<LiquidityMintEvent> = TypedEvent::new(e.raw());
            let amount = e.payload().amount_minted;

            println!("EEE Mint ({} LP)", amount);
        }
        LiquidityBurnEvent::SIGNATURE => {
            let e: TypedEvent<LiquidityBurnEvent> = TypedEvent::new(e.raw());
            let [r0, r1] = e.payload().amounts_redeemed;

            println!("EEE Burn (redeemed: {r0}/{r1})");
        }
        SwapEvent::SIGNATURE => {
            let e: TypedEvent<SwapEvent> = TypedEvent::new(e.raw());
            let payload = e.payload();
            let amounts_in = payload.amounts_in;
            let amounts_out = payload.amounts_out;

            println!(
                "EEE Swap ({}/{} => {}/{})",
                amounts_in[0], amounts_in[1], amounts_out[0], amounts_out[1]
            );
        }
        SyncEvent::SIGNATURE => {
            let e: TypedEvent<SyncEvent> = TypedEvent::new(e.raw());
            let reserves = e.payload().reserves;

            println!("EEE Sync (reserves: {}/{})", reserves[0], reserves[1]);
        }
        _ => {}
    }
}
