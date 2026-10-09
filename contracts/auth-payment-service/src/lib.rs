//! The inner service knows the payer; callers only forward an opaque token.
//! See the README for the complete wallet -> forwarder -> service -> ERC20 flow.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

use groundhog_erc20_permit_if::{ERC20PermitClient, PermitGrant};
use sdk::signer::{Opaque, Signed};
use sdk::storage::Value;
use sdk::*;

/// The wallet and service agree on this payload; the forwarder does not decode it.
/// The runtime releases `debit` only when the service consumes this parent token.
#[contract_type]
pub struct PaymentAuthorization {
    pub to: ContractAddress,
    pub amount: u128,
    pub debit: Signed<PermitGrant>,
}

#[contract_exception]
pub enum PaymentError {
    AlreadyInitialized = 1,
    NotAdministrator = 2,
    WrongPayer = 3,
    RequestMismatch = 4,
}

#[sdk::storage]
pub struct PaymentService {
    administrator: Value<ContractAddress>,
    payer: Value<ContractAddress>,
    token: Value<ContractAddress>,
}

#[contract(throws = PaymentError)]
impl PaymentService {
    /// Deploy and initialize atomically: the first caller sets the configuration.
    pub fn initialize(
        &mut self,
        administrator: &ContractAddress,
        payer: &ContractAddress,
        token: &ContractAddress,
    ) {
        if self.administrator.try_get().none_if_missing().is_some() {
            throw(PaymentError::AlreadyInitialized);
        }
        self.administrator.set(administrator);
        self.payer.set(payer);
        self.token.set(token);
    }

    pub fn set_payer(&mut self, payer: &ContractAddress) {
        if get_caller() != self.administrator.get() {
            throw(PaymentError::NotAdministrator);
        }
        self.payer.set(payer);
    }

    /// A transaction builder can read these settings without simulating a payment.
    /// The forwarder never calls either getter. A stale payer produces a refusal.
    pub fn get_payer(&self) -> ContractAddress {
        self.payer.get()
    }

    pub fn get_token(&self) -> ContractAddress {
        self.token.get()
    }

    /// No `from` argument: the service's own state chooses whose auth is required.
    /// The handle's type is opaque at this boundary, keeping payload details out
    /// of intermediate callers. `assume` does not authenticate anything; consuming
    /// and checking the runtime-supplied minter does.
    pub fn pay(&self, to: &ContractAddress, amount: u128, authorization: Signed<Opaque>) {
        let (payment, minter) = authorization.assume::<PaymentAuthorization>().consume();
        if minter != self.payer.get() {
            throw(PaymentError::WrongPayer);
        }
        if payment.to != *to || payment.amount != amount {
            throw(PaymentError::RequestMismatch);
        }

        // The wallet minted both nodes, so the child's minter is the same payer.
        // ERC20 checks its consumer, this service as spender, and the amount bound.
        // A plain call propagates a failure and rolls back this payment.
        ERC20PermitClient::new(&self.token.get()).transfer_from_signed(payment.debit, to, amount);
    }
}
