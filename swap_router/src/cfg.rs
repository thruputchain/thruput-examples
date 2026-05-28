#![allow(clippy::result_large_err)]

#[cfg(feature = "dev")]
use groundhog_erc20_if::*;

use sdk::*;
use swap::*;
use swap_driver::*;

#[contract_type]
pub struct Cfg {
    // In a complete implementation, the router would talk to a swap-pair factory:
    // pub factory: Address,

    // For now, we just deal with one swap-pair:
    pub driver: Address,
    pub swap_pair: Address,
    pub token0: Address,
    pub token1: Address,
}

impl Cfg {
    pub fn get_pair(
        &self,
        token_a: &Address,
        token_b: &Address,
    ) -> (ISwapV2PairClient, SwapV2DriverClient) {
        // Just assert that this is the one pair we know about
        assert_eq!(token_a, &self.token0);
        assert_eq!(token_b, &self.token1);

        (self.pair(), self.driver())
    }

    fn pair(&self) -> ISwapV2PairClient {
        ISwapV2PairClient::new(&self.swap_pair)
    }

    fn driver(&self) -> SwapV2DriverClient {
        SwapV2DriverClient::new(&self.driver)
    }

    #[cfg(feature = "dev")]
    pub fn token0(&self) -> ERC20Client {
        ERC20Client::new(&self.token0)
    }

    #[cfg(feature = "dev")]
    pub fn token1(&self) -> ERC20Client {
        ERC20Client::new(&self.token1)
    }
}
