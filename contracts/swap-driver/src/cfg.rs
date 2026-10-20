use swap_if::SwapHandlerClient;
use thruput_sdk::*;

#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
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
