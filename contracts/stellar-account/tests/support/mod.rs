//! Shared fixture for the account tests.
//!
//! Every state-changing account entry point requires the root invocation, so
//! these tests cannot drive the account through a client from another
//! address. Instead `as_account` opens the account's own frame as the root,
//! sets the calldata the entry point will decode, attaches the auth claim the
//! test wants observed, and runs the generated raw entrypoint. The mock does
//! not verify signatures, so the claim's `required_weight` is the whole input
//! to the threshold check.
#![allow(dead_code)]

use ed25519_dalek::SigningKey;
use groundhog_xdr::auth_claim::AuthClaim_source_address_claim;
use sdk::call::RawCallError;
use sdk::*;
use stellar_account::AccountError;
use stellar_account_factory_if::StellarAccountInitializerClient;

pub const ROOT: ContractAddress = ContractAddress::new([0x10; 32]);
pub const ACCOUNT: ContractAddress = ContractAddress::new([0x20; 32]);
pub const TOKEN: ContractAddress = ContractAddress::new([0x30; 32]);
pub const RECEIVER: ContractAddress = ContractAddress::new([0x40; 32]);

const MASTER_SEED: [u8; 32] = [0x11; 32];
const SECOND_SEED: [u8; 32] = [0x22; 32];

pub const MINTED: u128 = 1_000;

pub fn key_from(seed: &[u8; 32]) -> Ed25519PublicKey {
    Ed25519PublicKey::from(SigningKey::from_bytes(seed).verifying_key().to_bytes())
}
pub fn master_key() -> Ed25519PublicKey {
    key_from(&MASTER_SEED)
}
pub fn second_key() -> Ed25519PublicKey {
    key_from(&SECOND_SEED)
}

/// A source-address claim asking for `weight`. Any registered signer is
/// allowed; the account ignores the bitmap, as Stellar does.
pub fn claim(weight: u32) -> AuthClaim {
    AuthClaim::kSourceAddressAuthData {
        source_address_claim: AuthClaim_source_address_claim {
            allowed_keys: 0xFFFF_FFFF,
            required_weight: weight,
        },
    }
}

/// The claim a bare pubkey account carries. It names no weight.
pub fn pubkey_claim() -> AuthClaim {
    AuthClaim::kPubkeySignature {
        pubkey_preimage: PubkeyAccountPreimage {
            pubkey: PublicKey::Ed25519 {
                ed25519: master_key(),
            },
            nonce: 0,
        },
    }
}

/// Run `entry` as the account's root invocation with `claim` attached and
/// `args` as the calldata it decodes. `entry` is one of the
/// `stellar_account_exports::*_internal` raw entrypoints.
pub fn as_account<A: WriteXDR>(
    env: &TestEnvironmentHandle,
    claim: AuthClaim,
    args: &A,
    entry: fn(),
) -> TransactResult {
    let calldata = BytesM(sdk::xdr::cxs::encode(args).expect("encoding calldata"));
    env.transaction()
        .with_auth_claim(claim)
        .transact(|tx| tx.call(&ACCOUNT).with_calldata(calldata).run(entry))
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

pub fn balance_of(env: &TestEnvironmentHandle, who: ContractAddress) -> u128 {
    let result = env.transact(|tx| {
        tx.call(&ROOT)
            .run(move || erc20::ERC20Client::new(&TOKEN).get_balance_of(&who))
    });
    result.assert_success();
    result.assert_return_as::<u128>()
}
