//! Test-only wallet contract for token-factory caller checks.
//!
//! This fixture exists only for host tests and must never enter a release
//! manifest.

#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::*;
use token_factory_test_if::{TokenFactoryFailingChildClient, TokenFactoryTestWallet};

sdk::declare_mock_contract!();

/// Stateless wallet fixture that forwards a caller probe.
pub struct TestWallet;

#[contract(exports = "token_factory_test_wallet_exports")]
impl TokenFactoryTestWallet for TestWallet {
    fn probe_caller(child: &ContractAddress) -> ContractAddress {
        TokenFactoryFailingChildClient::new(child).caller()
    }
}
