//! A minimal fixed-key wallet minting a nested payment authorization.
//! Signature verification and replay protection use the same SignedOp component
//! as permit-wallet. Only the application payload and minted tree differ.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

use auth_payment_service::PaymentAuthorization;
use groundhog_erc20_permit_if::PermitGrant;
use groundhog_signed_op::{Operation, SignedOp, SignedOpReplayCache};
use sdk::mintable::{AuthTokenPreimage, MintableType};
use sdk::signer::{Opaque, Signed};
use sdk::storage::Value;
use sdk::types::{Ed25519PublicKey, Ed25519Signature};
use sdk::*;

type PaymentPreimage = <PaymentAuthorization as MintableType>::Preimage;
type DebitPreimage = <PermitGrant as MintableType>::Preimage;

/// The signer knows the service, asset, recipient and amount. No execution trace
/// or preflight is needed. The verifying wallet address is bound by SignedOp.
#[contract_type]
pub struct PaymentRequest {
    pub service: ContractAddress,
    pub token: ContractAddress,
    pub to: ContractAddress,
    pub amount: u128,
}

#[contract_exception]
pub enum WalletError {
    AlreadyInitialized = 1,
}

#[sdk::storage]
pub struct PaymentWallet {
    owner: Value<Ed25519PublicKey>,
    replay: SignedOpReplayCache,
}

#[contract(throws = WalletError)]
impl PaymentWallet {
    /// Deploy and initialize atomically; this demonstration has no key rotation.
    pub fn initialize(&mut self, owner: &Ed25519PublicKey) {
        if self.owner.try_get().none_if_missing().is_some() {
            throw(WalletError::AlreadyInitialized);
        }
        self.owner.set(owner);
    }
}

#[contract(version = "0.1.0")]
impl SignedOp for PaymentWallet {
    fn execute_signed_op(&mut self, op: Operation, signature: &Ed25519Signature) -> Signed<Opaque> {
        let expiry = op.block_expiry_height.clone();
        let request: PaymentRequest = self.replay.consume(&op, signature, &self.owner.get());
        let node =
            sdk::mintable::build_auth_token_node::<PaymentAuthorization>(AuthTokenPreimage {
                consumer: request.service,
                data: PaymentPreimage {
                    to: request.to,
                    amount: request.amount,
                    debit: AuthTokenPreimage {
                        consumer: request.token,
                        data: DebitPreimage {
                            spender: request.service,
                            amount: request.amount,
                        },
                    },
                },
            });
        sdk::signer::mint_opaque_auth_token(expiry, &sdk::mintable::encode_auth_token_node(&node))
    }
}
