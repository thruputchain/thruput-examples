//! Shared fixture for the account tests.
//!
//! Every state-changing account entry point requires the root invocation, so
//! these tests cannot drive the account through a client from another
//! address. Instead `as_account` opens the account's own frame as the root,
//! sets the calldata the entry point will decode, attaches the auth claim the
//! test wants observed, and runs the generated raw entrypoint. The mock does
//! not verify signatures, so the claim's `required_weight` is the whole input
//! to the threshold check.
//!
//! [`chain_accepts`] is the other half: it asks the native executor's own
//! auth verifier whether a really signed transaction to the account would be
//! admitted, against the registration and required weight the chain holds
//! for the account (not the contract's mirror).
#![allow(dead_code)]

use ed25519_dalek::{Signer, SigningKey};
use stellar_account::{AccountError, MAX_SIGNERS, StellarAccount};
use stellar_account_factory_if::StellarAccountInitializerClient;
use thruput_domain_separator::transaction_signature_preimage;
use thruput_sdk::call::RawCallError;
use thruput_sdk::*;
use thruput_signing::{
    BuildCallTransaction, MlDsa65Signer, Signer as _, build_call_transaction, public_key_hash,
};
use thruput_xdr::auth_claim::{AuthClaim_source_address_claim, AuthVerifyErrorCode};
use thruput_xdr::transaction::{DecoratedSignature, SignedTransaction};

pub const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
pub const ACCOUNT: ContractAddress = ContractAddress::new([0x20; 32]);
pub const TOKEN: ContractAddress = ContractAddress::new([0x30; 32]);
pub const RECEIVER: ContractAddress = ContractAddress::new([0x40; 32]);

pub const MASTER_SEED: [u8; 32] = [0x11; 32];
pub const SECOND_SEED: [u8; 32] = [0x22; 32];
/// FIPS 204 key-generation seeds for the ML-DSA-65 signers.
pub const MLDSA_SEED: [u8; 32] = [0x44; 32];
pub const OTHER_MLDSA_SEED: [u8; 32] = [0x55; 32];

pub const MINTED: i128 = 1_000;

/// Every slot the chain has. hogd rejects a bitmap with any bit at or past
/// slot 21 (`kMaxSigners`) as `kAuthMalformed`.
pub const ALL_SLOTS: u32 = (1u32 << MAX_SIGNERS) - 1;

pub fn key_from(seed: &[u8; 32]) -> Ed25519PublicKey {
    Ed25519PublicKey::from(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}
pub fn master_key() -> Ed25519PublicKey {
    key_from(&MASTER_SEED)
}
pub fn second_key() -> Ed25519PublicKey {
    key_from(&SECOND_SEED)
}

/// A signer key for `set_signer`: Ed25519 from `seed`.
pub fn ed25519_signer(seed: &[u8; 32]) -> PublicKey {
    PublicKey::Ed25519 {
        ed25519: key_from(seed),
    }
}
/// The second Ed25519 key as a signer key.
pub fn second_signer() -> PublicKey {
    ed25519_signer(&SECOND_SEED)
}
/// A signer key for `set_signer`: ML-DSA-65 from the FIPS 204 seed `seed`.
pub fn mldsa_signer(seed: &[u8; 32]) -> PublicKey {
    MlDsa65Signer::from_seed(seed).public_key()
}

/// A key that signs a transaction to the account at a slot.
#[derive(Clone, Copy)]
pub enum Key<'a> {
    Ed25519(&'a [u8; 32]),
    MlDsa65(&'a [u8; 32]),
}

impl Key<'_> {
    /// Pure ML-DSA with an empty context for ML-DSA-65, as hogd verifies.
    pub fn sign(&self, preimage: &[u8]) -> Signature {
        match self {
            Key::Ed25519(seed) => Signature::Ed25519 {
                ed25519: Ed25519Signature::from(
                    SigningKey::from_bytes(seed).sign(preimage).to_bytes(),
                ),
            },
            Key::MlDsa65(seed) => MlDsa65Signer::from_seed(seed)
                .sign(preimage)
                .expect("ML-DSA-65 signing"),
        }
    }
}

/// A source-address claim asking for `weight`. Any registered signer is
/// allowed ([`ALL_SLOTS`]); the account ignores the bitmap, as Stellar does.
pub fn claim(weight: u32) -> AuthClaim {
    AuthClaim::kSourceAddressAuthData {
        source_address_claim: AuthClaim_source_address_claim {
            allowed_keys: ALL_SLOTS,
            required_weight: weight,
        },
    }
}

/// The claim a bare pubkey account carries. It names no weight.
pub fn pubkey_claim() -> AuthClaim {
    AuthClaim::kPubkeySignature {
        pubkey_preimage: PubkeyAccountPreimage {
            pubkey_hash: public_key_hash(&PublicKey::Ed25519 {
                ed25519: master_key(),
            }),
            nonce: 0,
        },
    }
}

/// Run `op` against the account as the transaction's root invocation, with
/// `claim` attached. `op` receives the contract state the way a generated
/// entrypoint would and calls the method under test directly, so the
/// root-invocation and claim-weight checks see exactly what they would on
/// chain. The mock does not verify signatures, so the claim's
/// `required_weight` is the whole input to the threshold check.
pub fn as_account<T, F>(env: &TestEnvironmentHandle, claim: AuthClaim, op: F) -> TransactResult
where
    T: WriteXDR,
    F: FnOnce(&mut StellarAccount) -> T,
{
    env.transaction().with_auth_claim(claim).transact(|tx| {
        tx.call(&ACCOUNT).run(std::panic::AssertUnwindSafe(move || {
            let mut state = thruput_sdk::storage::contract_state_root::<StellarAccount>();
            op(&mut state)
        }))
    })
}

/// The account refused the root invocation with `expected`.
pub fn assert_account_error(result: &TransactResult, expected: AccountError) {
    result.assert_abort();
    match into_root_call_result::<()>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<AccountError>(), Some(expected));
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

/// Account deployed and initialized for `master_key()`, an ERC20 at `TOKEN`
/// with `MINTED` units at the account, all committed and visible.
pub fn setup() -> TestEnvironmentHandle {
    setup_with_hash().0
}

/// [`setup`], also returning the account code hash so a factory can be
/// configured to deploy more accounts of the same code. The mock package is
/// registered exactly once here.
pub fn setup_with_hash() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let account = stellar_account::register_mock_contract(&env);
    let account_hash = *account.as_hash();
    account.deploy_contract_to(&ACCOUNT);
    erc20::register_mock_contract(&env).deploy_contract_to(&TOKEN);

    // Initialization is open to any caller and has no root requirement, so a
    // child-frame client call from ROOT is fine here.
    env.transact(|tx| {
        tx.call(&ROOT).run(|| {
            StellarAccountInitializerClient::new(&ACCOUNT).initialize(&master_key());
            let token = erc20::ERC20Client::new(&TOKEN);
            token.initialize(&ROOT);
            token.mint(&ACCOUNT, MINTED);
        })
    })
    .assert_success();
    env.advance_block();
    (env, account_hash)
}

pub fn balance_of(env: &TestEnvironmentHandle, who: ContractAddress) -> i128 {
    let result = env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || erc20::ERC20Client::new(&TOKEN).get_balance_of(&who))
    });
    result.assert_success();
    result.assert_return_as::<i128>()
}

/// Whether the chain would admit a transaction to `ACCOUNT` claiming
/// `required_weight` and signed by each `(slot, seed)` in `signers` (Ed25519
/// keys, slots strictly increasing). The native executor's verifier checks
/// the signatures and weights against the `AddressAuthData` it stores for the
/// account, with hogd's rule: the signers must reach
/// `max(stored required_weight, required_weight)`.
pub fn chain_accepts(
    env: &TestEnvironmentHandle,
    signers: &[(u32, &[u8; 32])],
    required_weight: u32,
) -> bool {
    let keys: Vec<(u32, Key<'_>)> = signers
        .iter()
        .map(|(slot, seed)| (*slot, Key::Ed25519(seed)))
        .collect();
    chain_accepts_keys(env, &keys, required_weight)
}

/// [`chain_accepts`] for signers of either scheme.
pub fn chain_accepts_keys(
    env: &TestEnvironmentHandle,
    signers: &[(u32, Key<'_>)],
    required_weight: u32,
) -> bool {
    chain_accepts_signatures(env, required_weight, |preimage| {
        signers
            .iter()
            .map(|(slot, key)| (*slot, key.sign(preimage)))
            .collect()
    })
}

/// [`chain_accepts`] with the signatures built by `sign` from the
/// transaction's signature preimage, so a test can tamper with one.
pub fn chain_accepts_signatures(
    env: &TestEnvironmentHandle,
    required_weight: u32,
    sign: impl FnOnce(&[u8]) -> Vec<(u32, Signature)>,
) -> bool {
    let height = env.transact(|tx| tx.call(&ROOT).run(get_block_height));
    height.assert_success();
    let height: BlockHeight = height.assert_return_as();
    let tx = build_call_transaction(BuildCallTransaction {
        invoked_address: ACCOUNT,
        entrypoint: ContractEntrypointID::from([0x5A; 8]),
        calldata: vec![],
        gas_limit: 1_000_000,
        block_expiry_height: *height + 100,
        nonce: 1,
        auth_claim: claim(required_weight),
    });
    let preimage = transaction_signature_preimage(&thruput_sdk::test_network_hash(), &tx)
        .expect("encoding the signature preimage");
    let signatures: Vec<DecoratedSignature> = sign(&preimage)
        .into_iter()
        .map(|(public_key_id, signature)| DecoratedSignature {
            public_key_id,
            signature,
        })
        .collect();
    let stx = SignedTransaction {
        tx,
        signatures: signatures.try_into().expect("fits"),
        pubkey_claim_key: None,
    };
    // The from-database path reports the mempool's pass/fail code: 0 is
    // admitted, anything else is refused.
    env.verify_signed_transaction_auth(&stx) == AuthVerifyErrorCode(0)
}

/// The key and weight the chain has registered at `slot` for `ACCOUNT`.
pub fn registered(env: &TestEnvironmentHandle, slot: u32) -> Option<(PublicKey, u32)> {
    let auth = env.get_snapshot_auth_data(&ACCOUNT)?;
    auth.public_keys[slot as usize]
        .as_ref()
        .map(|config| (config.key.clone(), config.max_weight))
}
