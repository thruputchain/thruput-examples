//! RPC integration test for the `erc20` contract.
//!
//! The common machinery — signing and submitting transactions through the
//! bootstrapped `dev-0` wallet, polling for receipts, and failure diagnostics —
//! lives in the `integration-test` crate. This file only describes the
//! contract-specific calls and the lifecycle they exercise.
//!
//! Run it with:
//!
//! ```bash
//! GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode \
//!     groundhog test --integration
//! ```

use groundhog_xdr::types::ContractAddress;
use integration_test::{Harness, decode_return, encode};

const INTERFACE: &str = "ERC20";
const VERSION: &str = "0.1.4";

#[tokio::test]
async fn erc20_lifecycle_over_rpc() {
    let token = Erc20::from_env();

    // The bootstrapped dev-0 wallet is the caller of every transaction below,
    // so it becomes the token administrator and the source of transfers.
    let admin = token.0.wallet();
    let recipient = token.0.dev_wallet(1);

    // Fresh deploy: total supply starts at zero (this also confirms the
    // contract is reachable before we initialize it).
    token.initialize(&admin).await;
    assert_eq!(
        token.total_supply().await,
        0,
        "fresh contract has no supply"
    );

    // Mint to the administrator and confirm supply and balance move together.
    token.mint(&admin, 1_000).await;
    assert_eq!(
        token.total_supply().await,
        1_000,
        "supply reflects the mint"
    );
    assert_eq!(
        token.balance_of(&admin).await,
        1_000,
        "admin holds the minted tokens"
    );

    // Transfer some away; both balances should update, supply should not.
    token.transfer(&recipient, 400).await;
    assert_eq!(token.balance_of(&admin).await, 600, "admin balance debited");
    assert_eq!(
        token.balance_of(&recipient).await,
        400,
        "recipient balance credited"
    );
    assert_eq!(
        token.total_supply().await,
        1_000,
        "transfers do not change supply"
    );
}

/// Contract-specific calls layered over the shared [`Harness`].
struct Erc20(Harness);

impl Erc20 {
    fn from_env() -> Self {
        Self(Harness::from_env(INTERFACE, VERSION))
    }

    async fn initialize(&self, administrator: &ContractAddress) {
        self.0.invoke("initialize", encode(administrator)).await;
    }

    async fn mint(&self, receiver: &ContractAddress, amount: u128) {
        self.0.invoke("mint", encode(&(*receiver, amount))).await;
    }

    async fn transfer(&self, receiver: &ContractAddress, amount: u128) {
        self.0
            .invoke("transfer", encode(&(*receiver, amount)))
            .await;
    }

    async fn total_supply(&self) -> u128 {
        decode_return(&self.0.invoke("total_supply", Vec::new()).await)
    }

    async fn balance_of(&self, owner: &ContractAddress) -> u128 {
        decode_return(&self.0.invoke("get_balance_of", encode(owner)).await)
    }
}
