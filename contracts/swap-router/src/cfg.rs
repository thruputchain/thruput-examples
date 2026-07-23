use sdk::*;
use swap_if::{Address, SwapDriverClient, SwapFactoryClient};

#[contract_type]
pub struct Cfg {
    // The factory the router resolves pairs through.
    pub factory: Address,
}

impl Cfg {
    fn factory(&self) -> SwapFactoryClient {
        SwapFactoryClient::new(&self.factory)
    }

    /// The driver for the `token_a`/`token_b` pair, creating the pair's suite
    /// through the factory if it doesn't exist yet -- cf. UniswapV2Router, whose
    /// `addLiquidity` creates the pair on first use.
    pub fn get_pair(&self, token_a: &Address, token_b: &Address) -> SwapDriverClient {
        let factory = self.factory();
        let suite = match factory.get_pair(token_a, token_b) {
            Some(_) => factory.predict_pair(token_a, token_b),
            None => factory.create_pair(token_a, token_b),
        };
        SwapDriverClient::new(&suite.driver)
    }

    /// Like `get_pair`, but accepts the tokens in either order; additionally
    /// returns the index (0 or 1) of `token_in` within the pair.
    pub fn get_pair_directed(
        &self,
        token_in: &Address,
        token_out: &Address,
    ) -> (SwapDriverClient, usize) {
        let driver = self.get_pair(token_in, token_out);

        // The pair's token0 is the smaller address (the factory's canonical
        // ordering), so `token_in` is at index 0 iff it sorts first.
        let in_index = if token_in <= token_out { 0 } else { 1 };

        (driver, in_index)
    }
}
