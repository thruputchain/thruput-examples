use super::*;

pub type Addresses = [ContractAddress; 2];

// Contract context tracked in swap tests
#[derive(Copy, Clone)]
pub struct Ctx {
    pub pair_addr: ContractAddress,
    pub liquidity_token: ContractAddress,
    pub token_addrs: Addresses,
}

impl Ctx {
    pub fn token0(&self) -> ERC20Client {
        ERC20Client::new(&self.token_addrs[0])
    }
    pub fn token1(&self) -> ERC20Client {
        ERC20Client::new(&self.token_addrs[1])
    }
    pub fn pair(&self) -> SwapPairClient {
        SwapPairClient::new(&self.pair_addr)
    }
    pub fn lp(&self) -> ERC20Client {
        ERC20Client::new(&self.liquidity_token)
    }
}

impl Ctx {
    pub fn my_balances(&self) -> (Amounts, Amount) {
        let token_balances = [self.token0().get_balance(), self.token1().get_balance()];
        let lp_balance = self.lp().get_balance();

        (token_balances, lp_balance)
    }

    pub fn user_print_balances(&self, user: &User) {
        assert_eq!(&get_current_address(), user.addr);

        print_balances(user.name, self.my_balances());
    }

    // The two halves of a liquidity purchase, split by who may perform them:
    // the depositor moves its own tokens, and only the handler may mint
    // against them.  (In production the handler does both, pulling the tokens
    // through an allowance; here the deposit is simply its own transaction.)

    // As a user, send all my AB-tokens to the pair.
    pub fn user_deposit_tokens(&self, user: &User) {
        let amt0 = self.token0().get_balance();
        let amt1 = self.token1().get_balance();

        self.token0().transfer(&self.pair_addr, amt0);
        self.token1().transfer(&self.pair_addr, amt1);

        // My accounts should be drained
        assert_eq!(0, self.token0().get_balance());
        assert_eq!(0, self.token1().get_balance());

        self.user_print_balances(user);
    }

    // As the handler, mint the LP those deposits earned to `user`.
    pub fn handler_mint_for(&self, user: &User) {
        let lp_minted = self.pair().mint_lp(user.addr, user.addr, None);

        println!("> {} bought {:.3} LP", user.name, decimalized(lp_minted));
    }

    // As a user, send all my LP tokens back to the pair.
    pub fn user_deposit_lp(&self, user: &User) {
        let lp = self.lp();

        let return_amt = lp.get_balance();
        lp.transfer(&self.pair_addr, return_amt);
        println!("> {} redeemed {:.3} LP", user.name, decimalized(return_amt));

        // I should have zero LP tokens now
        assert_eq!(lp.get_balance(), 0);
    }

    // As the handler, redeem those LP tokens for `user`.
    pub fn handler_burn_for(&self, user: &User) {
        self.pair().burn_lp(user.addr, user.addr, None);
    }

    // Make sure we're not holding any LP tokens
    pub fn factory_sync_skim_pair(&self) {
        let pair = self.pair();

        let (r0, r1, _ts) = pair.get_reserves();
        assert_eq!(r0, 0);
        assert_eq!(r1, 0);

        let our_lp = pair.get_liquidity();
        assert_eq!(0, our_lp);

        // This should be a no-op
        pair.sync();

        hash_ident! { static SOMEBODY: ContractAddress; }

        // This should be a no-op
        pair.skim(&SOMEBODY);

        // Called by anyone but the handler, an attributed operation is refused
        // before it gets as far as looking at the deposits -- which is what
        // keeps the sender and request id on its event worth anything.
        assert!(
            pair.try_mint_lp(&SOMEBODY, &SOMEBODY, None)
                .is_err_and(|e| is_pair_error_and(e, |e| e == SwapPairError::Unauthorized))
        );
    }
}
