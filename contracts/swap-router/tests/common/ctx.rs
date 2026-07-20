use super::*;

// Contract context tracked in swap tests
#[derive(Copy, Clone)]
pub struct Ctx {
    pub router_addr: Address,
    pub driver_addr: Address,
    // The request handler: the contract users must allow to spend their tokens.
    pub request_handler_addr: Address,
    pub pair_addr: Address,
    pub liquidity_token: Address,
    pub token_addrs: Addresses,
}

impl Ctx {
    pub fn token0(&self) -> ERC20Client {
        ERC20Client::new(&self.token_addrs[0])
    }
    pub fn token1(&self) -> ERC20Client {
        ERC20Client::new(&self.token_addrs[1])
    }
    pub fn token0_meta(&self) -> ERC20MetadataClient {
        ERC20MetadataClient::new(&self.token_addrs[0])
    }
    pub fn token1_meta(&self) -> ERC20MetadataClient {
        ERC20MetadataClient::new(&self.token_addrs[1])
    }
    pub fn pair(&self) -> SwapPairClient {
        SwapPairClient::new(&self.pair_addr)
    }
    pub fn lp(&self) -> ERC20Client {
        ERC20Client::new(&self.liquidity_token)
    }
    pub fn driver(&self) -> SwapV2DriverClient {
        SwapV2DriverClient::new(&self.driver_addr)
    }
    pub fn router(&self) -> RouterClient {
        RouterClient::new(&self.router_addr)
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

        let symbols = [
            self.token0_meta().symbol().unwrap(),
            self.token1_meta().symbol().unwrap(),
        ];

        print_balances(user.name, self.my_balances(), symbols);
    }

    pub fn quote01(&self, amount0: Amount) -> Amount {
        assert!(amount0 > 0, "Insufficient amount");

        let (r0, r1, _) = self.pair().get_reserves();
        assert!(r0 > 0 && r1 > 0, "Insufficient liquidity");

        let amount1 = (U256::from(amount0) * U256::from(r1)) / U256::from(r0);

        amount1.try_into().unwrap()
    }

    pub fn calculate_swap(&self, amounts_in: Amounts) -> Amounts {
        assert!(
            !(amounts_in[0] > 0 && amounts_in[1] > 0),
            "Please don't swap with two tokens at once"
        );
        assert!(
            amounts_in[0] > 0 || amounts_in[1] > 0,
            "Can't calculate swap of nothing"
        );

        let reserves = [
            self.token0().get_balance_of(&self.pair_addr),
            self.token1().get_balance_of(&self.pair_addr),
        ];
        assert!(reserves[0] > 0 && reserves[1] > 0);

        let in_index = if amounts_in[0] > 0 { 0 } else { 1 };
        let out_index = 1 - in_index;

        let amount_in = amounts_in[in_index];
        let reserve_in = reserves[in_index];
        let reserve_out = reserves[out_index];

        // amount_in_with_fee = amount_in * 997
        // amount_out = amount_in_with_fee / ((reserve_in * 1000) + amount_in_with_fee)

        let amount_in_with_fee: U256 = Into::<U256>::into(amount_in) * 997;
        let numerator: U256 = amount_in_with_fee * Into::<U256>::into(reserve_out);
        let denominator: U256 = (Into::<U256>::into(reserve_in) * 1000) + amount_in_with_fee;
        let amount_out = numerator / denominator;

        let mut amounts_out: Amounts = [0, 0];
        amounts_out[out_index] = amount_out.try_into().unwrap();

        amounts_out
    }

    // Buy LP tokens in exchange for all my A/B tokens
    pub fn user_buy_unpriced(&self, user: &User) {
        assert_eq!(user.addr, &get_current_address());

        let amts = [self.token0().get_balance(), self.token1().get_balance()];

        // Transfer our AB-tokens to the pair contract
        self.token0().transfer(&self.pair_addr, amts[0]);
        self.token1().transfer(&self.pair_addr, amts[1]);

        let lp_minted = self.pair().mint_lp(user.addr);

        // Our balances should be drained
        assert_eq!(0, self.token0().get_balance());
        assert_eq!(0, self.token1().get_balance());

        {
            println!("> {} bought {:.3} LP", user.name, decimalized(lp_minted));
            self.user_print_balances(user);
        }
    }

    // As a user, provide AB-token liquidity in exchange for LP tokens.
    // (Calculate the right A/B ratio.)
    pub fn user_buy(&self, user: &User) {
        assert_eq!(user.addr, &get_current_address());

        let amt0 = self.token0().get_balance();
        let amt1 = self.quote01(amt0);

        let bal1 = self.token1().get_balance();
        assert!(bal1 >= amt1);

        // Transfer our AB-tokens to the pair contract
        self.token0().transfer(&self.pair_addr, amt0);
        self.token1().transfer(&self.pair_addr, amt1);

        let lp_minted = self.pair().mint_lp(user.addr);

        // Our token0 balance should be drained
        assert_eq!(0, self.token0().get_balance());

        {
            println!("> {} bought {:.3} LP", user.name, decimalized(lp_minted));
            self.user_print_balances(user);
        }
    }

    // As a user, redeem swap-pair tokens
    pub fn user_redeem(&self, user: &User) {
        let pair = self.pair();
        let lp = self.lp();

        // Return all my LP tokens to the swap-pair contract
        let return_amt = lp.get_balance();
        lp.transfer(&self.pair_addr, return_amt);
        println!("> {} redeemed {:.3} LP", user.name, decimalized(return_amt));

        // I should have zero LP tokens now
        assert_eq!(lp.get_balance(), 0);

        // Redeem the LP tokens for pair tokens
        pair.burn_lp(user.addr);

        self.user_print_balances(user);
    }

    // Prepare to transfer LP allowances back to swap-pair contract
    pub fn user_redeem_prepare(&self, user: &User) -> i128 {
        let return_amt = self.lp().get_balance().try_into().unwrap();

        // Give the swap-pair access to all my LP tokens
        self.lp().adjust_allowance(&self.pair_addr, return_amt);

        return_amt
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

        hash_ident! { static SOMEBODY: Address; }

        // This should be a no-op
        pair.skim(&SOMEBODY);

        assert!(pair.try_mint_lp(&SOMEBODY).is_err_and(
            |e| is_pair_error_and(e, |e| e == SwapPairError::InsufficientLiquidityMinted)
        ));
    }
}
