//! Carries an owner's signed permit to their token in one frame.
//!
//! The permit flow has two on-chain halves: the owner's wallet verifies the
//! off-chain signature and mints a `PermitGrant` auth token, and the ERC20
//! consumes that token. A token minted in one frame has to be consumed in the
//! same frame, so *someone* makes both calls back to back. This contract is
//! that someone. Anyone may call [`relay`](PermitRelayer::relay), exactly as
//! anyone may submit an ERC-2612 `permit`, and the submitter's identity plays
//! no part: the grant's owner is its minter, and its spender is in the body
//! the owner signed.
//!
//! Stateless: no storage, nothing to initialize.

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

use groundhog_erc20_permit_if::{ERC20PermitClient, PermitGrant};
use groundhog_signed_op_if::{Operation, SignedOpClient};
use sdk::signer::Signed;
use sdk::types::Ed25519Signature;
use sdk::*;

/// The relayer contract.
pub struct PermitRelayer;

#[contract]
impl PermitRelayer {
    /// Take `op` and `signature` to `wallet`, then pass the grant it mints to
    /// `token`'s `permit`, which records an allowance for the grant's spender.
    ///
    /// A refusal anywhere along the way — an invalid, expired or replayed
    /// signature at the wallet, or a grant the token will not consume —
    /// throws out of this frame, so a relayed permit either lands whole or
    /// leaves no trace.
    pub fn relay(
        wallet: &ContractAddress,
        token: &ContractAddress,
        op: Operation,
        signature: &Ed25519Signature,
    ) {
        let grant: Signed<PermitGrant> = SignedOpClient::new(wallet)
            .execute_signed_op(op, signature)
            .assume();
        ERC20PermitClient::new(token).permit(grant);
    }
}
