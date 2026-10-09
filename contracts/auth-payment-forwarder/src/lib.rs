//! The outer `fn1`: knows the service's calling interface, not its payer or grants.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

use auth_payment_service::PaymentServiceClient;
use sdk::signer::{Opaque, Signed};
use sdk::*;

pub struct PaymentForwarder;

#[contract]
impl PaymentForwarder {
    pub fn forward(
        service: &ContractAddress,
        to: &ContractAddress,
        amount: u128,
        authorization: Signed<Opaque>,
    ) {
        PaymentServiceClient::new(service).pay(to, amount, authorization);
    }
}
