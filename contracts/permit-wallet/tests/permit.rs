//! The permit flow end to end on the SDK's native executor: an owner signs
//! off-chain, someone else submits.
//!
//! Three contracts take part. Alice's `permit-wallet` holds her ERC20 balance
//! and verifies her signatures; the `erc20` consumes the grants her wallet
//! mints; the `permit-relayer` is the submitter, carrying a signed permit from
//! the one to the other in a single frame. Alice's key exists only in this
//! test — she never submits a transaction — and the assertions are about what
//! a submitter can and cannot change about a signature they are merely
//! carrying.
//!
//! # Blocks, not sequence points
//!
//! Every transaction in a block executes against the state the *previous*
//! block left, so each write below is followed by `advance_block` before
//! anything reads it.

use ed25519_dalek::{Signer, SigningKey};
use erc20::{
    ClearAllowanceGrant, ClearAllowanceRequest, ERC20Client, ERC20Error, ERC20PermitClient,
    ERC20PermitError, PermitGrant, PermitRequest,
};
use groundhog_domain_separator::SignedOp as SignedOpPreimage;
use groundhog_signed_op_if::{Operation, SignedOpClient, SignedOpError};
use permit_relayer::PermitRelayerClient;
use permit_wallet::{PermitWalletClient, WalletRequest};
use sdk::signer::Signed;
use sdk::types::transaction::Uniquifier;
use sdk::types::{Ed25519PublicKey, Ed25519Signature};
use sdk::xdr::BytesM;
use sdk::*;

const ALICE_SEED: [u8; 32] = [0x11; 32];
const MALLORY_SEED: [u8; 32] = [0x22; 32];

const MINTED: u128 = 1_000;
const GRANTED: u128 = 250;

/// How many blocks past signing a permit stays valid: enough to survive the
/// `advance_block`s a test needs to observe its own effects.
const HORIZON: i64 = 8;

fn wallet() -> ContractAddress {
    ContractAddress::named("alice-wallet")
}
fn token() -> ContractAddress {
    ContractAddress::named("token")
}
fn relayer() -> ContractAddress {
    ContractAddress::named("relayer")
}
fn admin() -> ContractAddress {
    ContractAddress::named("admin")
}
fn spender() -> ContractAddress {
    ContractAddress::named("spender")
}
fn receiver() -> ContractAddress {
    ContractAddress::named("receiver")
}

fn public_key(seed: &[u8; 32]) -> Ed25519PublicKey {
    Ed25519PublicKey::from(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}

/// The three contracts deployed, the wallet accepting Alice's key, and every
/// minted unit sitting at the wallet's address — all visible, because the
/// block that wrote them has been advanced past.
fn setup() -> TestEnvironmentHandle {
    let env = TestEnvironment::no_cost();
    permit_wallet::register_mock_contract(&env).deploy_contract_to(&wallet());
    erc20::register_mock_contract(&env).deploy_contract_to(&token());
    permit_relayer::register_mock_contract(&env).deploy_contract_to(&relayer());

    env.transact(|tx| {
        tx.call(&admin()).run(|| {
            PermitWalletClient::new(&wallet()).initialize(&admin(), &public_key(&ALICE_SEED));
            let erc20 = ERC20Client::new(&token());
            erc20.initialize(&admin());
            erc20.mint(&wallet(), MINTED);
        })
    })
    .assert_success();
    env.advance_block();
    env
}

/// The current height, read from inside a frame because that is the only
/// place the syscall answers.
fn current_height(env: &TestEnvironmentHandle) -> BlockHeight {
    let result = env.transact(|tx| tx.call(&token()).run(sdk::block::get_block_height));
    result.assert_success();
    result.assert_return_as::<BlockHeight>()
}

/// What an off-chain signer does: build the preimage from the network, the
/// wallet, the `(nonce, expiry)` uniquifier and the body's `TYPE_DEF`, then
/// sign it. The key reaches neither contract; the wallet checks against the
/// key it holds. The body is the wallet's own request type, which names the
/// grant it should mint.
fn sign(
    seed: &[u8; 32],
    verifying_contract: &ContractAddress,
    nonce: u64,
    expiry: BlockHeight,
    body: &WalletRequest,
) -> (Operation, Ed25519Signature) {
    let key = SigningKey::from_bytes(seed);
    let preimage = SignedOpPreimage {
        network: sdk::test_network_hash(),
        verifying_contract: *verifying_contract,
        uniquifier: Uniquifier {
            block_expiry_height: expiry.clone(),
            nonce,
        },
        body,
    }
    .preimage()
    .expect("encoding the signed-operation preimage");

    let op = Operation {
        block_expiry_height: expiry,
        nonce,
        body: BytesM(sdk::xdr::cxs::encode(body).expect("encoding the body")),
    };
    (op, Ed25519Signature::from(key.sign(&preimage).to_bytes()))
}

/// The permit Alice signs in most of these tests: up to `GRANTED` units of
/// `token()`, spendable by `spender()`.
fn standard_request() -> WalletRequest {
    WalletRequest::Permit(PermitRequest {
        token: token(),
        spender: spender(),
        amount: GRANTED,
    })
}

/// Alice's request to revoke `spender()`'s allowance on `token()`.
fn clear_request() -> WalletRequest {
    WalletRequest::ClearAllowance(ClearAllowanceRequest {
        token: token(),
        spender: spender(),
    })
}

/// Alice's standard permit at nonce 0, valid through `expiry`. ed25519 is
/// deterministic, so rebuilding it with the same expiry yields the same bytes
/// a submitter would have kept a copy of.
fn alice_permit_until(expiry: BlockHeight) -> (Operation, Ed25519Signature) {
    sign(&ALICE_SEED, &wallet(), 0, expiry, &standard_request())
}

fn alice_permit(env: &TestEnvironmentHandle) -> (Operation, Ed25519Signature) {
    alice_permit_until(current_height(env) + HORIZON)
}

/// The submitter's first step, inside a frame: take the operation to Alice's
/// wallet and name the grant it mints. `T` is only what the submitter claims
/// the grant is; the token decodes the payload when it consumes it.
fn mint_grant<T: sdk::mintable::MintableType>(
    op: Operation,
    signature: &Ed25519Signature,
) -> Signed<T> {
    SignedOpClient::new(&wallet())
        .execute_signed_op(op, signature)
        .assume()
}

/// Sign `body` as Alice at `nonce`, then submit it as `spender()` and redeem
/// it through `redeem` inside the same frame.
fn submit_signed<F>(
    env: &TestEnvironmentHandle,
    nonce: u64,
    body: WalletRequest,
    redeem: F,
) -> TransactResult
where
    F: FnOnce(Operation, Ed25519Signature) + std::panic::UnwindSafe + 'static,
{
    let (op, signature) = sign(
        &ALICE_SEED,
        &wallet(),
        nonce,
        current_height(env) + HORIZON,
        &body,
    );
    env.transact(|tx| tx.call(&spender()).run(move || redeem(op, signature)))
}

/// Submit as `spender()` through the relayer: the wallet mints, the token
/// consumes, one frame.
fn relay(
    env: &TestEnvironmentHandle,
    op: Operation,
    signature: Ed25519Signature,
) -> TransactResult {
    env.transact(|tx| {
        tx.call(&spender()).run(move || {
            PermitRelayerClient::new(&relayer()).relay(&wallet(), &token(), op, &signature);
        })
    })
}

/// Assert that the wallet refuses `op` with `expected`. The check happens
/// inside the frame because a `CallError` is not XDR-encodable and cannot
/// leave it; a refused operation mints nothing, so nothing reaches the token.
macro_rules! assert_wallet_refuses {
    ($env:expr, $op:expr, $signature:expr, $expected:expr $(,)?) => {{
        let (op, signature) = ($op, $signature);
        $env.transact(|tx| {
            tx.call(&spender()).run(move || {
                let result = SignedOpClient::new(&wallet()).try_execute_signed_op(op, &signature);
                assert_eq!(result.unwrap_err().try_as(), Some($expected));
            })
        })
        .assert_success();
    }};
}

fn balance_of(env: &TestEnvironmentHandle, who: ContractAddress) -> u128 {
    let result = env.transact(|tx| {
        tx.call(&admin())
            .run(move || ERC20Client::new(&token()).get_balance_of(&who))
    });
    result.assert_success();
    result.assert_return_as::<u128>()
}

fn allowance(env: &TestEnvironmentHandle) -> u128 {
    let result = env.transact(|tx| {
        tx.call(&admin())
            .run(|| ERC20Client::new(&token()).allowance(&wallet(), &spender()))
    });
    result.assert_success();
    result.assert_return_as::<u128>()
}

fn rotate_owner_as(
    env: &TestEnvironmentHandle,
    caller: ContractAddress,
    new_owner: Ed25519PublicKey,
) -> TransactResult {
    env.transact(|tx| {
        tx.call(&caller).run(move || {
            PermitWalletClient::new(&wallet()).rotate_owner(&new_owner);
        })
    })
}

#[test]
fn a_relayed_permit_records_an_allowance_the_spender_draws_on() {
    let env = setup();
    let (op, signature) = alice_permit(&env);

    // Submitted by the spender, but it would work from any address: the
    // authority comes from Alice's signature, not from who carries it.
    relay(&env, op, signature).assert_success();
    env.advance_block();
    assert_eq!(allowance(&env), GRANTED);

    env.transact(|tx| {
        tx.call(&spender()).run(|| {
            ERC20Client::new(&token()).transfer_from(&wallet(), &receiver(), GRANTED);
        })
    })
    .assert_success();
    env.advance_block();

    assert_eq!(balance_of(&env, receiver()), GRANTED);
    assert_eq!(balance_of(&env, wallet()), MINTED - GRANTED);
    assert_eq!(allowance(&env), 0);
}

/// The other spending path: no relayer and no allowance. The spender takes
/// the grant to `transfer_from_signed` itself, in one frame.
#[test]
fn transfer_from_signed_moves_the_balance_and_leaves_no_allowance() {
    let env = setup();
    let (op, signature) = alice_permit(&env);

    env.transact(|tx| {
        tx.call(&spender()).run(move || {
            let grant = mint_grant(op, &signature);
            ERC20PermitClient::new(&token()).transfer_from_signed(grant, &receiver(), GRANTED);
        })
    })
    .assert_success();
    env.advance_block();

    assert_eq!(balance_of(&env, receiver()), GRANTED);
    assert_eq!(balance_of(&env, wallet()), MINTED - GRANTED);
    // The capability was spent, not copied into storage where it would
    // outlive the transfer.
    assert_eq!(allowance(&env), 0);
}

/// A grant is a ceiling, not an exact amount: the spender moves what it
/// needs, and the unused remainder goes nowhere.
#[test]
fn transfer_from_signed_moves_up_to_the_granted_amount() {
    let env = setup();
    submit_signed(&env, 0, standard_request(), |op, signature| {
        let grant = mint_grant(op, &signature);
        ERC20PermitClient::new(&token()).transfer_from_signed(grant, &receiver(), GRANTED - 50);
    })
    .assert_success();
    env.advance_block();

    assert_eq!(balance_of(&env, receiver()), GRANTED - 50);
    assert_eq!(balance_of(&env, wallet()), MINTED - GRANTED + 50);
    assert_eq!(allowance(&env), 0, "the remainder is not kept as allowance");
}

#[test]
fn transfer_from_signed_refuses_more_than_the_grant() {
    let env = setup();
    submit_signed(&env, 0, standard_request(), |op, signature| {
        let grant = mint_grant(op, &signature);
        let result = ERC20PermitClient::new(&token()).try_transfer_from_signed(
            grant,
            &receiver(),
            GRANTED + 1,
        );
        assert_eq!(
            result.unwrap_err().try_as(),
            Some(ERC20PermitError::ExceedsGrant)
        );
    })
    .assert_success();
    env.advance_block();

    assert_eq!(balance_of(&env, receiver()), 0);
    assert_eq!(balance_of(&env, wallet()), MINTED);
}

/// The grant names who may spend it. Someone else presenting a genuine grant
/// is refused by the token, not by the wallet.
#[test]
fn only_the_named_spender_may_redeem_a_grant_directly() {
    let env = setup();
    let (op, signature) = alice_permit(&env);

    env.transact(|tx| {
        tx.call(&receiver()).run(move || {
            let grant = mint_grant(op, &signature);
            let result = ERC20PermitClient::new(&token()).try_transfer_from_signed(
                grant,
                &receiver(),
                GRANTED,
            );
            assert_eq!(
                result.unwrap_err().try_as(),
                Some(ERC20PermitError::NotSpender)
            );
        })
    })
    .assert_success();
    env.advance_block();

    assert_eq!(balance_of(&env, receiver()), 0);
}

/// The relayer reads the signed body to pick the token method, so a clear
/// request relays the same way a permit does, and takes the allowance back.
#[test]
fn a_relayed_clear_revokes_the_allowance() {
    let env = setup();
    let (op, signature) = alice_permit(&env);
    relay(&env, op, signature).assert_success();
    env.advance_block();
    assert_eq!(allowance(&env), GRANTED);

    let (op, signature) = sign(
        &ALICE_SEED,
        &wallet(),
        1,
        current_height(&env) + HORIZON,
        &clear_request(),
    );
    relay(&env, op, signature).assert_success();
    env.advance_block();
    assert_eq!(allowance(&env), 0);
}

/// A body the wallet could not decode is refused by the relayer before the
/// wallet sees it; nothing is minted and nothing is consumed.
#[test]
fn the_relayer_refuses_a_body_that_is_not_a_wallet_request() {
    let env = setup();
    let (mut op, signature) = alice_permit(&env);
    op.body.0.truncate(1);

    env.transact(|tx| {
        tx.call(&spender()).run(move || {
            let result =
                PermitRelayerClient::new(&relayer()).try_relay(&wallet(), &token(), op, &signature);
            assert_eq!(
                result.unwrap_err().try_as(),
                Some(permit_relayer::RelayError::NotAWalletRequest)
            );
        })
    })
    .assert_success();
    env.advance_block();
    assert_eq!(allowance(&env), 0);
}

/// A signed clear takes a standing allowance back: the entry is deleted, and
/// the spender can no longer draw on it.
#[test]
fn clear_allowance_signed_revokes_a_standing_allowance() {
    let env = setup();
    let (op, signature) = alice_permit(&env);
    relay(&env, op, signature).assert_success();
    env.advance_block();
    assert_eq!(allowance(&env), GRANTED);

    submit_signed(&env, 1, clear_request(), |op, signature| {
        let grant = mint_grant::<ClearAllowanceGrant>(op, &signature);
        ERC20PermitClient::new(&token()).clear_allowance_signed(grant);
    })
    .assert_success();
    env.advance_block();
    assert_eq!(allowance(&env), 0);

    env.transact(|tx| {
        tx.call(&spender()).run(|| {
            let result = ERC20Client::new(&token()).try_transfer_from(&wallet(), &receiver(), 1);
            assert_eq!(result.unwrap_err().try_as(), Some(ERC20Error::TooLarge));
        })
    })
    .assert_success();
}

/// The signed body names the operation, and the grant's payload follows it:
/// a grant signed to raise an allowance cannot be redeemed as a clear, and a
/// clear cannot be redeemed as a transfer. The token refuses to decode the
/// payload as the other type, so the call aborts.
#[test]
fn a_grant_cannot_be_redeemed_for_a_different_operation() {
    let env = setup();
    submit_signed(&env, 0, standard_request(), |op, signature| {
        let grant = mint_grant::<ClearAllowanceGrant>(op, &signature);
        ERC20PermitClient::new(&token()).clear_allowance_signed(grant);
    })
    .assert_abort();
    env.advance_block();

    submit_signed(&env, 1, clear_request(), |op, signature| {
        let grant = mint_grant::<PermitGrant>(op, &signature);
        ERC20PermitClient::new(&token()).transfer_from_signed(grant, &receiver(), 0);
    })
    .assert_abort();
    env.advance_block();

    assert_eq!(allowance(&env), 0);
    assert_eq!(balance_of(&env, receiver()), 0);
}

/// Replay protection is the chain's uniquifier model: the `(nonce, expiry)`
/// pair is consumed once at the wallet, so the same bytes are refused in any
/// later block, and the relayer's frame aborts before the token sees them.
#[test]
fn a_replayed_permit_is_refused() {
    let env = setup();
    let expiry = current_height(&env) + HORIZON;

    let (op, signature) = alice_permit_until(expiry.clone());
    relay(&env, op, signature).assert_success();
    env.advance_block();

    let (op, signature) = alice_permit_until(expiry.clone());
    relay(&env, op, signature).assert_abort();
    let (op, signature) = alice_permit_until(expiry);
    assert_wallet_refuses!(&env, op, signature, SignedOpError::AlreadyConsumed);

    env.advance_block();
    assert_eq!(allowance(&env), GRANTED, "the replay added nothing");
}

/// The wallet checks against the key it holds, and nothing on the wire names
/// Mallory's, so her signature simply does not verify.
#[test]
fn a_signature_from_another_key_is_refused() {
    let env = setup();
    let expiry = current_height(&env) + HORIZON;
    let (op, signature) = sign(&MALLORY_SEED, &wallet(), 0, expiry, &standard_request());

    assert_wallet_refuses!(&env, op, signature, SignedOpError::InvalidSignature);

    env.advance_block();
    assert_eq!(allowance(&env), 0);
}

/// Alice signs, then the administrator rotates her key before anyone submits.
/// Authority is wallet state, so the rotation is one write, and Alice's
/// signature no longer verifies under the key the wallet now checks against.
/// Nobody but the administrator can make that write.
#[test]
fn rotating_the_owner_key_refuses_outstanding_permits() {
    let env = setup();
    let (op, signature) = alice_permit(&env);

    rotate_owner_as(&env, spender(), public_key(&MALLORY_SEED)).assert_abort();
    rotate_owner_as(&env, admin(), public_key(&MALLORY_SEED)).assert_success();
    env.advance_block();

    assert_wallet_refuses!(&env, op, signature, SignedOpError::InvalidSignature);

    env.advance_block();
    assert_eq!(allowance(&env), 0);
    assert_eq!(balance_of(&env, wallet()), MINTED);
}

/// A rotation and a permit under the outgoing key can share a block: every
/// transaction in it runs against the state the previous block left, so the
/// permit is checked against the key the block began with, and both commit.
/// Rotation takes effect from the next block, not from the transaction after
/// it.
#[test]
fn a_rotation_takes_effect_from_the_next_block() {
    let env = setup();
    let (op, signature) = alice_permit(&env);

    rotate_owner_as(&env, admin(), public_key(&MALLORY_SEED)).assert_success();
    // Same block: no `advance_block` between the rotation and the relay.
    relay(&env, op, signature).assert_success();
    env.advance_block();
    assert_eq!(allowance(&env), GRANTED, "honored under the outgoing key");

    // From this block on, Alice's key is no longer the owner.
    let expiry = current_height(&env) + HORIZON;
    let (op, signature) = sign(&ALICE_SEED, &wallet(), 1, expiry, &standard_request());
    assert_wallet_refuses!(&env, op, signature, SignedOpError::InvalidSignature);
}
