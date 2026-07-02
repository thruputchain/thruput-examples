use sdk::*;
use swap_request::ISwapRequestHandlerClient;

#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
pub struct Cfg {
    // The contract that handles dequeued requests.
    pub handler: ContractAddress,
}

impl Cfg {
    pub fn handler(&self) -> ISwapRequestHandlerClient {
        ISwapRequestHandlerClient::new(&self.handler)
    }
}
