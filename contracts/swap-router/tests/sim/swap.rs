//! Typed clients for the `swap-if` interfaces (see [`super::client`]).

use swap_if::{Addresses, Amount, Amounts, Pool, PoolFunding, RequestId, SwapHashes, SwapRequest};
use thruput_testkit::{Caller, Contract, ContractCall, Result};

use super::Address;
use super::client::Bound;

#[derive(Debug, Clone)]
pub struct SwapFactoryClient(Bound);

impl SwapFactoryClient {
    pub const INTERFACE: (&str, &str) = ("SwapFactory", "0.1.0");

    pub fn new(caller: &(impl AsRef<Caller> + ?Sized), address: Address) -> Self {
        let (interface, version) = Self::INTERFACE;
        Self(Bound::new(
            caller,
            Contract::new(address, interface, version),
        ))
    }

    pub fn address(&self) -> Address {
        self.0.address()
    }

    pub fn initialize(
        &self,
        hashes: SwapHashes,
        fee_to: Option<Address>,
        router: &Address,
    ) -> ContractCall<()> {
        self.0.call("initialize", &(hashes, fee_to, *router))
    }

    pub async fn fee_to(&self) -> Result<Option<Address>> {
        self.0.view("fee_to", &()).await
    }

    pub async fn pool_funding(&self) -> Result<PoolFunding> {
        self.0.view("pool_funding", &()).await
    }

    pub fn create_pair(
        &self,
        token_a: &Address,
        token_b: &Address,
        funding: Amount,
    ) -> ContractCall<Pool> {
        self.0.call("create_pair", &(*token_a, *token_b, funding))
    }

    pub async fn pool_addresses(&self, token_a: &Address, token_b: &Address) -> Result<Pool> {
        self.0.view("pool_addresses", &(*token_a, *token_b)).await
    }

    pub async fn get_pair(&self, token_a: &Address, token_b: &Address) -> Result<Option<Address>> {
        self.0.view("get_pair", &(*token_a, *token_b)).await
    }

    pub async fn all_pairs_length(&self) -> Result<u32> {
        self.0.view("all_pairs_length", &()).await
    }

    pub async fn pair_at(&self, index: u32) -> Result<Option<Addresses>> {
        self.0.view("pair_at", &index).await
    }
}

// The router's request methods are declared `&self` in `SwapRouter`, but each
// one submits a request to the pair's driver, so they are calls, not views.
#[derive(Debug, Clone)]
pub struct SwapRouterClient(Bound);

impl SwapRouterClient {
    pub const INTERFACE: (&str, &str) = ("SwapRouter", "0.1.0");

    pub fn new(caller: &(impl AsRef<Caller> + ?Sized), address: Address) -> Self {
        let (interface, version) = Self::INTERFACE;
        Self(Bound::new(
            caller,
            Contract::new(address, interface, version),
        ))
    }

    pub fn address(&self) -> Address {
        self.0.address()
    }

    pub fn initialize(&self, factory: &Address) -> ContractCall<()> {
        self.0.call("initialize", factory)
    }

    pub fn add_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        amounts_desired: Amounts,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> ContractCall<RequestId> {
        self.0.call(
            "add_liquidity",
            &(*token_a, *token_b, amounts_desired, amounts_min, *recipient),
        )
    }

    pub fn remove_liquidity(
        &self,
        token_a: &Address,
        token_b: &Address,
        liquidity: Amount,
        amounts_min: Amounts,
        recipient: &Address,
    ) -> ContractCall<RequestId> {
        self.0.call(
            "remove_liquidity",
            &(*token_a, *token_b, liquidity, amounts_min, *recipient),
        )
    }

    pub fn swap_exact_tokens_for_tokens(
        &self,
        amount_in: Amount,
        amount_out_min: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    ) -> ContractCall<RequestId> {
        self.0.call(
            "swap_exact_tokens_for_tokens",
            &(amount_in, amount_out_min, *token_in, *token_out, *recipient),
        )
    }

    pub fn swap_tokens_for_exact_tokens(
        &self,
        amount_out: Amount,
        amount_in_max: Amount,
        token_in: &Address,
        token_out: &Address,
        recipient: &Address,
    ) -> ContractCall<RequestId> {
        self.0.call(
            "swap_tokens_for_exact_tokens",
            &(amount_out, amount_in_max, *token_in, *token_out, *recipient),
        )
    }
}

#[derive(Debug, Clone)]
pub struct SwapDriverClient(Bound);

impl SwapDriverClient {
    pub const INTERFACE: (&str, &str) = ("SwapDriver", "0.1.0");

    pub fn new(caller: &(impl AsRef<Caller> + ?Sized), address: Address) -> Self {
        let (interface, version) = Self::INTERFACE;
        Self(Bound::new(
            caller,
            Contract::new(address, interface, version),
        ))
    }

    pub fn address(&self) -> Address {
        self.0.address()
    }

    pub fn initialize(
        &self,
        handler: &Address,
        router: &Address,
        max_queue_len: u32,
        min_crank_batch: u32,
    ) -> ContractCall<()> {
        self.0.call(
            "initialize",
            &(*handler, *router, max_queue_len, min_crank_batch),
        )
    }

    pub fn request(&self, request: SwapRequest) -> ContractCall<RequestId> {
        self.0.call("request", &request)
    }

    /// Process queued requests, returning `(processed, failed)`.
    pub fn process_requests(&self) -> ContractCall<(u32, u32)> {
        self.0.call("process_requests", &())
    }
}
