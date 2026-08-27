use sdk::*;
use swap_if::SwapHandlerClient;

#[derive(ReadXDR, WriteXDR)]
#[xdrs(crate = "::sdk::__xdrs")]
pub struct Cfg {
    // The contract that handles dequeued requests.
    pub handler: ContractAddress,

    // The queue's ceiling, kept here so that `process_requests` can tell how
    // deep the queue is: `Slots` counts the room *left*, and the difference is
    // what is waiting.
    pub max_queue_len: u32,

    // The most a crank can be required to clear before it may drain at all.
    pub min_crank_batch: u32,
}

impl Cfg {
    pub fn handler(&self) -> SwapHandlerClient {
        SwapHandlerClient::new(&self.handler)
    }
}
