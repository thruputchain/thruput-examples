use super::*;

hash_ident! { pub static SOMEBODY: ContractAddress; }

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

    // As a user, send all my AB-tokens to the pair.
    pub fn user_deposit_tokens(&self, _user: &User) {
        let amt0 = self.token0().get_balance();
        let amt1 = self.token1().get_balance();

        self.token0().transfer(&self.pair_addr, amt0);
        self.token1().transfer(&self.pair_addr, amt1);

        // My accounts should be drained
        assert_eq!(0, self.token0().get_balance());
        assert_eq!(0, self.token1().get_balance());
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

    // Make sure we're not holding any LP tokens
    pub fn empty_pair_is_a_no_op(&self, pair: &mut Node<Pair>) {
        let (r0, r1, _ts) = pair.get_reserves();
        assert_eq!(r0, 0);
        assert_eq!(r1, 0);

        assert_eq!(0, pair.get_liquidity());

        // These should be no-ops
        pair.sync();
        pair.skim(&SOMEBODY);
    }
}
