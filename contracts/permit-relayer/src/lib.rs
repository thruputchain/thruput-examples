//! Carries an owner's signed operation to their token in one frame.
//!
//! The permit flow has two on-chain halves: the owner's wallet verifies the
//! off-chain signature and mints a grant auth token, and the ERC20 consumes
//! that token. A token minted in one frame has to be consumed in the same
//! frame, so *someone* makes both calls back to back. This contract is that
//! someone. Anyone may call [`relay`](PermitRelayer::relay), exactly as anyone
//! may submit an ERC-2612 `permit`, and the submitter's identity plays no
//! part: the grant's owner is its minter, and its spender is in the body the
//! owner signed.
//!
//! The wallet mints whichever grant the signed [`WalletRequest`] asks for, so
//! the relayer reads that body to know where the grant goes: a permit becomes
//! a standing allowance through `increase_allowance_signed`, and a clear
//! revokes one through `clear_allowance_signed`. The remaining path,
//! `transfer_from_signed`, needs no relayer, since the spender it names makes
//! both calls itself.
//!
//! Stateless: no storage, nothing to initialize.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

use groundhog_erc20_permit_if::{ClearAllowanceGrant, ERC20PermitClient, PermitGrant};
use groundhog_signed_op_if::{Operation, SignedOpClient};
use permit_wallet::WalletRequest;
use sdk::signer::Signed;
use sdk::types::Ed25519Signature;
use sdk::*;

/// Why the relayer refused, before anything reached the wallet.
#[contract_exception]
#[non_exhaustive]
#[cfg_attr(feature = "dev", derive(thiserror::Error))]
pub enum RelayError {
    /// The operation's body is not a [`WalletRequest`], so there is no
    /// telling which grant the wallet would mint. The wallet would refuse
    /// the same bytes; this refusal just comes first.
    #[cfg_attr(feature = "dev", error("Operation body is not a wallet request"))]
    NotAWalletRequest = 1,
}

/// The relayer contract.
pub struct PermitRelayer;

#[contract(throws = RelayError)]
impl PermitRelayer {
    /// Take `op` and `signature` to `wallet`, then pass the grant it mints to
    /// `token`: a permit request adds the granted amount to the allowance of
    /// its spender through `increase_allowance_signed`, and a clear request
    /// revokes that spender's allowance through `clear_allowance_signed`.
    ///
    /// A refusal anywhere along the way — a body that is not a wallet
    /// request, an invalid, expired or replayed signature at the wallet, or a
    /// grant the token will not consume — throws out of this frame, so a
    /// relayed operation either lands whole or leaves no trace.
    pub fn relay(
        wallet: &ContractAddress,
        token: &ContractAddress,
        op: Operation,
        signature: &Ed25519Signature,
    ) {
        // The body says which grant the wallet will mint. Reading it here
        // decides nothing about authorization: the wallet still verifies the
        // signature over these same bytes before minting anything.
        let request: WalletRequest = sdk::xdr::cxs::decode(op.body.0.as_slice())
            .unwrap_or_else(|_| throw(RelayError::NotAWalletRequest));

        let minted = SignedOpClient::new(wallet).execute_signed_op(op, signature);
        let token = ERC20PermitClient::new(token);
        match request {
            WalletRequest::Permit(_) => {
                let grant: Signed<PermitGrant> = minted.assume();
                token.increase_allowance_signed(grant);
            }
            WalletRequest::ClearAllowance(_) => {
                let grant: Signed<ClearAllowanceGrant> = minted.assume();
                token.clear_allowance_signed(grant);
            }
        }
    }
}
