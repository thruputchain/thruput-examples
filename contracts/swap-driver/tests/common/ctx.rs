use super::*;

// Contract context tracked in swap tests
#[derive(Copy, Clone)]
pub struct Ctx {
    pub driver_addr: Address,
    pub request_handler_addr: Address,
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
    #[cfg(feature = "erc20_metadata")]
    pub fn token0_meta(&self) -> ERC20MetadataClient {
        ERC20MetadataClient::new(&self.token_addrs[0])
    }
    #[cfg(feature = "erc20_metadata")]
    pub fn token1_meta(&self) -> ERC20MetadataClient {
        ERC20MetadataClient::new(&self.token_addrs[1])
    }
    pub fn handler(&self) -> SwapHandlerClient {
        SwapHandlerClient::new(&self.request_handler_addr)
    }

    // The pool: the handler performs the pair's operations and holds its reserves, so it is what
    // answers for them.
    pub fn pair(&self) -> SwapHandlerClient {
        SwapHandlerClient::new(&self.request_handler_addr)
    }
    pub fn lp(&self) -> ERC20Client {
        ERC20Client::new(&self.liquidity_token)
    }
    pub fn driver(&self) -> SwapDriverClient {
        SwapDriverClient::new(&self.driver_addr)
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

        #[cfg(feature = "erc20_metadata")]
        let symbols = [
            self.token0_meta().symbol().unwrap(),
            self.token1_meta().symbol().unwrap(),
        ];
        #[cfg(feature = "erc20_metadata")]
        let symbols = symbols.each_ref().map(|s| s.as_str());

        #[cfg(not(feature = "erc20_metadata"))]
        let symbols = ["TOK1".try_into().unwrap(), "TOK2".try_into().unwrap()];

        print_balances(user.name, self.my_balances(), symbols);
    }

    /// Given an amount of token0, give a price quote for token1
    pub fn quote01(&self, amount0: Amount) -> Amount {
        assert!(amount0 > 0, "Insufficient amount");

        let [r0, r1] = self.pair().pool_state().reserves;
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
            self.token0().get_balance_of(&self.request_handler_addr),
            self.token1().get_balance_of(&self.request_handler_addr),
        ];
        assert!(reserves[0] > 0 && reserves[1] > 0);

        let in_index = if amounts_in[0] > 0 { 0 } else { 1 };
        let out_index = 1 - in_index;

        let amount_in = amounts_in[in_index];
        let reserve_in = reserves[in_index];
        let reserve_out = reserves[out_index];

        // amount_in_with_fee = amount_in * 997 amount_out = amount_in_with_fee / ((reserve_in *
        // 1000) + amount_in_with_fee)

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
        self.token0().transfer(&self.request_handler_addr, amts[0]);
        self.token1().transfer(&self.request_handler_addr, amts[1]);

        // Our balances should be drained
        assert_eq!(0, self.token0().get_balance());
        assert_eq!(0, self.token1().get_balance());

        self.user_print_balances(user);
    }

    // As a user, provide AB-token liquidity in exchange for LP tokens. (Calculate the right A/B
    // ratio.)
    pub fn user_buy(&self, user: &User) {
        assert_eq!(user.addr, &get_current_address());

        let amt0 = self.token0().get_balance();
        let amt1 = self.quote01(amt0);

        let bal1 = self.token1().get_balance();
        assert!(bal1 >= amt1);

        // Transfer our AB-tokens to the pair contract
        self.token0().transfer(&self.request_handler_addr, amt0);
        self.token1().transfer(&self.request_handler_addr, amt1);

        // Our token0 balance should be drained
        assert_eq!(0, self.token0().get_balance());

        self.user_print_balances(user);
    }

    // As a user: allow the handler to take the tokens a liquidity purchase will need, and report
    // the amounts the request should name.
    pub fn user_buy_prepare(&self, user: &User) -> Amounts {
        let amt0 = self.token0().get_balance();
        let amt1 = self.quote01(amt0);

        let bal1 = self.token1().get_balance();
        assert!(bal1 >= amt1);

        // We want to sell all our A tokens and the equivalent amount of B tokens for LP tokens
        let amounts = [amt0, amt1];

        // Give the request handler access to my tokens
        self.token0()
            .adjust_allowance(&self.request_handler_addr, amounts[0].try_into().unwrap());
        self.token1()
            .adjust_allowance(&self.request_handler_addr, amounts[1].try_into().unwrap());

        self.user_print_balances(user);

        amounts
    }

    // As the router: enqueue that purchase on the user's behalf.
    pub fn user_buy_request(&self, user: &User, amounts: Amounts) {
        // The optimal ratio is recomputed at execution time; we accept any.
        self.driver().request(SwapRequest::add_liquidity(
            user.addr,
            amounts,
            [0, 0],
            user.addr,
        ));

        println!(
            "> {} request LP purchase with (A, B): {amounts:?}",
            user.name
        );
    }

    // As a user, deposit LP tokens for redemption
    pub fn user_redeem(&self, user: &User) {
        let lp = self.lp();

        // Return all my LP tokens to the swap-pair contract
        let return_amt = lp.get_balance();
        lp.transfer(&self.request_handler_addr, return_amt);
        println!("> {} redeemed {:.3} LP", user.name, decimalized(return_amt));

        // I should have zero LP tokens now
        assert_eq!(lp.get_balance(), 0);
    }

    // Prepare to transfer LP allowances to the request handler
    pub fn user_redeem_prepare(&self, user: &User) -> i128 {
        let return_amt = self.lp().get_balance().try_into().unwrap();

        // Give the request handler access to all my LP tokens
        self.lp()
            .adjust_allowance(&self.request_handler_addr, return_amt);

        return_amt
    }

    pub fn user_redeem_request(&self, user: &User, allowed: i128) {
        self.driver().request(SwapRequest::remove_liquidity(
            user.addr,
            allowed as u128,
            [0, 0],
            user.addr,
        ));

        println!(
            "> {} request LP redeem: {:.3?} LP",
            user.name,
            decimalized(allowed as u128),
        );
    }

    // Make sure we're not holding any LP tokens
    pub fn empty_pool_is_a_no_op(&self, pair: &mut Node<Pair>) {
        let (r0, r1, _ts) = pair.get_reserves();
        assert_eq!(r0, 0);
        assert_eq!(r1, 0);

        assert_eq!(0, pair.get_liquidity());

        hash_ident! { static SOMEBODY: ContractAddress; }

        // These should be no-ops
        pair.sync();
        pair.skim(&SOMEBODY);
    }
}
