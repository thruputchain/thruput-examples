use groundhog_erc20_if::ERC20Client;
use sdk::*;
use swap::*;

/// Handler configuration: the pair it drives, that pair's tokens, and the
/// pair's LP token.
#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
pub struct Cfg {
    pub swap_pair: Address,
    pub tokens: [Address; 2],
    pub lp_token: Address,
}

impl Cfg {
    pub fn pair(&self) -> ISwapV2PairClient {
        ISwapV2PairClient::new(&self.swap_pair)
    }

    pub fn tokens(&self) -> [ERC20Client; 2] {
        self.tokens.map(|ref addr| ERC20Client::new(addr))
    }

    pub fn lp(&self) -> ERC20Client {
        ERC20Client::new(&self.lp_token)
    }
}
