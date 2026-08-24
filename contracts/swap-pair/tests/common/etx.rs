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

    // A liquidity purchase takes two transactions, because it takes two
    // callers: the user deposits its own tokens, and only the handler may mint
    // against them.  They also take two *blocks* -- the mint sizes itself from
    // the pair's balances, and a transaction reads the balances its block
    // began with, so a deposit in the same block would be invisible to it.
    pub fn user_buy(&self, user: User) -> Result<(), TransactResult> {
        let ctx = self.ctx;
        self.exec_user_tx(user, |u| ctx.user_deposit_tokens(u))?;
        self.advance_block();
        self.exec_user_tx(HANDLER, move |_| ctx.handler_mint_for(&user))
    }

    // Likewise a redemption.
    pub fn user_redeem(&self, user: User) -> Result<(), TransactResult> {
        let ctx = self.ctx;
        self.exec_user_tx(user, |u| ctx.user_deposit_lp(u))?;
        self.advance_block();
        self.exec_user_tx(HANDLER, move |_| ctx.handler_burn_for(&user))?;
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
                    ctx.token0().get_balance_of(&ctx.pair_addr),
                    ctx.token1().get_balance_of(&ctx.pair_addr),
                ],
                ctx.lp().get_balance_of(&ctx.pair_addr),
            )
        })
    }

    // What allowances has the user given to the pair contract?
    pub fn user_pledges(&self, user: User) -> Result<Amounts> {
        let ctx = &self.ctx;
        exec_tx(&self.env, &TEST_ADDR, || {
            [
                ctx.token0().allowance(user.addr, &ctx.pair_addr),
                ctx.token1().allowance(user.addr, &ctx.pair_addr),
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
    use groundhog_erc20_if as erc20;
    use swap_pair::events::*;

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
        MintEvent::SIGNATURE => {
            let e: TypedEvent<MintEvent> = TypedEvent::new(e.raw());
            let amount = e.payload().amount_minted;

            println!("EEE Mint ({} LP)", amount);
        }
        BurnEvent::SIGNATURE => {
            let e: TypedEvent<BurnEvent> = TypedEvent::new(e.raw());
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
