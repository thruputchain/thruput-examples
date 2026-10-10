//! RPC integration test for the `counter` contract.
//!
//! The common machinery — signing and submitting transactions through the
//! bootstrapped `dev-0` wallet, polling for receipts, and failure diagnostics —
//! lives in the `integration-test` crate. This file only describes the
//! contract-specific calls and the lifecycle they exercise.
//!
//! Run it with:
//!
//! ```bash
//! THRUPUT_DEVNODE_BINARY=/path/to/hog-devnode \
//!     thruput test --integration
//! ```

use integration_test::{Harness, decode_return, encode};

const INTERFACE: &str = "Counter";
const VERSION: &str = "0.1.0";

#[tokio::test]
async fn lifecycle() {
    let counter = Counter::from_env();

    let initial_value: u64 = 11;

    counter.initialize(initial_value).await;
    assert_eq!(counter.get().await, initial_value);
}

/// Contract-specific calls layered over the shared [`Harness`].
struct Counter(Harness);

impl Counter {
    fn from_env() -> Self {
        Self(Harness::from_env(INTERFACE, VERSION))
    }

    async fn initialize(&self, initial_value: u64) {
        self.0.invoke("initialize", encode(&(initial_value,))).await;
    }

    async fn get(&self) -> u64 {
        decode_return(&self.0.invoke("get", encode(&())).await)
    }
}
