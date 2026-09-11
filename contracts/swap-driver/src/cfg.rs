use sdk::*;
use swap_if::SwapHandlerClient;

#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
pub struct Cfg {
    // The contract that handles dequeued requests.
    pub handler: ContractAddress,

    // The only contract whose requests this driver will enqueue.
    pub router: ContractAddress,
}

impl Cfg {
    pub fn handler(&self) -> SwapHandlerClient {
        SwapHandlerClient::new(&self.handler)
    }
}
