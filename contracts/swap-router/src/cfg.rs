use sdk::*;
use swap_if::{Address, SwapDriverClient, SwapFactoryClient, SwapRouterError};

#[contract_type]
pub struct Cfg {
    // The factory the router resolves pairs through.
    pub factory: Address,
}

impl Cfg {
    fn factory(&self) -> SwapFactoryClient {
        SwapFactoryClient::new(&self.factory)
    }

    /// The driver for an *existing* `token_a`/`token_b` pair.
    ///
    /// The router never creates a pool.  UniswapV2's router does, on first
    /// `addLiquidity`, but creating one here costs its creator real HOG -- the
    /// pool's contracts are funded as they are deployed -- and that is not
    /// something to have happen as a side effect of adding liquidity.  Pools
    /// are created by calling [`SwapFactory::create_pair`] directly.
    pub fn get_pair(&self, token_a: &Address, token_b: &Address) -> SwapDriverClient {
        SwapDriverClient::new(&self.factory().pool_addresses(token_a, token_b).driver)
    }

    /// Like [`get_pair`](Self::get_pair), but refuses a pair the factory has
    /// no record of, rather than routing at an address with nothing behind it.
    pub fn get_existing_pair(&self, token_a: &Address, token_b: &Address) -> SwapDriverClient {
        let factory = self.factory();
        ensure(
            factory.get_pair(token_a, token_b).is_some(),
            SwapRouterError::NoSuchPair,
        );

        SwapDriverClient::new(&factory.pool_addresses(token_a, token_b).driver)
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
