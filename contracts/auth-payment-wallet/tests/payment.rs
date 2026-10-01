//! A real signature mints a parent capability, which crosses the opaque forwarder
//! and releases a child capability consumed by the existing ERC20 implementation.
//! These are native-executor tests, not a live-node or RPC simulation.

use auth_payment_forwarder::PaymentForwarderClient;
use auth_payment_service::{PaymentError, PaymentServiceClient};
use auth_payment_wallet::{PaymentRequest, PaymentWalletClient};
use ed25519_dalek::{Signer, SigningKey};
use erc20::ERC20Client;
use groundhog_domain_separator::SignedOp as SignedOpPreimage;
use groundhog_signed_op::{Operation, SignedOpClient};
use sdk::types::transaction::Uniquifier;
use sdk::types::{Ed25519PublicKey, Ed25519Signature};
use sdk::xdr::BytesM;
use sdk::*;

const ALICE_KEY: [u8; 32] = [0x11; 32];
const BOB_KEY: [u8; 32] = [0x22; 32];
const INITIAL: u128 = 1_000;
const PAYMENT: u128 = 250;

fn addr(name: &str) -> ContractAddress {
    ContractAddress::named(name)
}

fn setup() -> TestEnvironmentHandle {
    let env = TestEnvironment::no_cost();
    let wallet = auth_payment_wallet::register_mock_contract(&env);
    wallet.deploy_contract_to(&addr("alice"));
    wallet.deploy_contract_to(&addr("bob"));
    let service = auth_payment_service::register_mock_contract(&env);
    service.deploy_contract_to(&addr("service"));
    service.deploy_contract_to(&addr("other-service"));
    auth_payment_forwarder::register_mock_contract(&env).deploy_contract_to(&addr("forwarder"));
    erc20::register_mock_contract(&env).deploy_contract_to(&addr("token"));
    env.transact(|tx| {
        tx.call(&addr("admin")).run(|| {
            for (name, seed) in [("alice", ALICE_KEY), ("bob", BOB_KEY)] {
                let key = SigningKey::from_bytes(&seed);
                let public_key = Ed25519PublicKey::from(key.verifying_key().to_bytes());
                PaymentWalletClient::new(&addr(name)).initialize(&public_key);
            }
            for name in ["service", "other-service"] {
                PaymentServiceClient::new(&addr(name)).initialize(
                    &addr("admin"),
                    &addr("alice"),
                    &addr("token"),
                );
            }
            let token = ERC20Client::new(&addr("token"));
            token.initialize(&addr("admin"));
            token.mint(&addr("alice"), INITIAL);
            token.mint(&addr("bob"), INITIAL);
        })
    })
    .assert_success();
    env.advance_block();
    env
}

fn expiry(env: &TestEnvironmentHandle) -> BlockHeight {
    // Reading a height is not preflighting the payment or discovering auths.
    let result = env.transact(|tx| tx.call(&addr("relayer")).run(sdk::block::get_block_height));
    result.assert_success();
    result.assert_return_as::<BlockHeight>() + 8
}

fn request() -> PaymentRequest {
    PaymentRequest {
        service: addr("service"),
        token: addr("token"),
        to: addr("receiver"),
        amount: PAYMENT,
    }
}

struct Authorization {
    wallet: ContractAddress,
    op: Operation,
    signature: Ed25519Signature,
}

/// Transaction preparation knows the wallet and request schema. The forwarder
/// does not: it sees only the handle returned after this signature is verified.
fn sign(
    wallet: ContractAddress,
    seed: &[u8; 32],
    expiry: BlockHeight,
    body: PaymentRequest,
) -> Authorization {
    let preimage = SignedOpPreimage {
        network: sdk::test_network_hash(),
        verifying_contract: wallet,
        uniquifier: Uniquifier {
            block_expiry_height: expiry.clone(),
            nonce: 0,
        },
        body: &body,
    }
    .preimage()
    .unwrap();
    Authorization {
        wallet,
        op: Operation {
            block_expiry_height: expiry,
            nonce: 0,
            body: BytesM(sdk::xdr::cxs::encode(&body).unwrap()),
        },
        signature: Ed25519Signature::from(SigningKey::from_bytes(seed).sign(&preimage).to_bytes()),
    }
}

fn submit(
    env: &TestEnvironmentHandle,
    auth: Authorization,
    service: ContractAddress,
    to: ContractAddress,
    amount: u128,
    expected_error: Option<PaymentError>,
) -> TransactResult {
    env.transact(|tx| {
        tx.call(&addr("relayer")).run(move || {
            let opaque = SignedOpClient::new(&auth.wallet)
                .execute_signed_op(auth.op, &auth.signature);
            let forwarder = PaymentForwarderClient::new(&addr("forwarder"));
            if let Some(expected) = expected_error {
                let error = forwarder.try_forward(&service, &to, amount, opaque).unwrap_err();
                assert_eq!(error.try_as(), Some(expected));
                // Propagate after checking the reason: the entire transaction,
                // including the wallet nonce consumed above, must roll back.
                error.re_throw();
            } else {
                forwarder.forward(&service, &to, amount, opaque);
            }
        })
    })
}

fn balance(env: &TestEnvironmentHandle, name: &str) -> u128 {
    let owner = addr(name);
    let result = env.transact(|tx| {
        tx.call(&addr("reader"))
            .run(move || ERC20Client::new(&addr("token")).get_balance_of(&owner))
    });
    result.assert_success();
    result.assert_return_as::<u128>()
}

#[test]
fn opaque_forwarding_pays_once_without_a_from_argument_or_standing_allowance() {
    let env = setup();
    let expiry = expiry(&env);
    submit(
        &env,
        sign(addr("alice"), &ALICE_KEY, expiry.clone(), request()),
        addr("service"),
        addr("receiver"),
        PAYMENT,
        None,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(balance(&env, "alice"), INITIAL - PAYMENT);
    assert_eq!(balance(&env, "bob"), INITIAL);
    assert_eq!(balance(&env, "receiver"), PAYMENT);
    let result = env.transact(|tx| {
        tx.call(&addr("reader")).run(|| {
            ERC20Client::new(&addr("token")).allowance(&addr("alice"), &addr("service"))
        })
    });
    result.assert_success();
    assert_eq!(result.assert_return_as::<u128>(), 0);

    submit(
        &env,
        sign(addr("alice"), &ALICE_KEY, expiry, request()),
        addr("service"),
        addr("receiver"),
        PAYMENT,
        None,
    )
    .assert_abort();
    env.advance_block();
    assert_eq!(balance(&env, "receiver"), PAYMENT);
}

#[test]
fn only_the_inner_service_needs_to_know_that_the_payer_changed() {
    let env = setup();
    let expiry = expiry(&env);
    env.transact(|tx| {
        tx.call(&addr("admin"))
            .run(|| PaymentServiceClient::new(&addr("service")).set_payer(&addr("bob")))
    })
    .assert_success();
    env.advance_block();

    // A valid Alice signature is no longer the authorization this service needs.
    submit(
        &env,
        sign(addr("alice"), &ALICE_KEY, expiry.clone(), request()),
        addr("service"),
        addr("receiver"),
        PAYMENT,
        Some(PaymentError::WrongPayer),
    )
    .assert_abort();

    // The transaction builder supplies Bob's authorization. The same deployed
    // forwarder receives the same business arguments and still sees no `from`.
    submit(
        &env,
        sign(addr("bob"), &BOB_KEY, expiry, request()),
        addr("service"),
        addr("receiver"),
        PAYMENT,
        None,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(balance(&env, "alice"), INITIAL);
    assert_eq!(balance(&env, "bob"), INITIAL - PAYMENT);
    assert_eq!(balance(&env, "receiver"), PAYMENT);
}

#[test]
fn the_relayer_cannot_change_the_recipient_or_amount_and_refusal_rolls_back_the_nonce() {
    let env = setup();
    let expiry = expiry(&env);
    for (to, amount) in [(addr("mallory"), PAYMENT), (addr("receiver"), PAYMENT + 1)] {
        submit(
            &env,
            sign(addr("alice"), &ALICE_KEY, expiry.clone(), request()),
            addr("service"),
            to,
            amount,
            Some(PaymentError::RequestMismatch),
        )
        .assert_abort();
    }
    // Same signed request, same nonce: earlier failures did not burn the permit.
    submit(
        &env,
        sign(addr("alice"), &ALICE_KEY, expiry, request()),
        addr("service"),
        addr("receiver"),
        PAYMENT,
        None,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(balance(&env, "alice"), INITIAL - PAYMENT);
    assert_eq!(balance(&env, "receiver"), PAYMENT);
    assert_eq!(balance(&env, "mallory"), 0);
}

#[test]
fn an_identical_service_at_another_address_cannot_consume_the_parent() {
    let env = setup();
    let expiry = expiry(&env);
    submit(
        &env,
        sign(addr("alice"), &ALICE_KEY, expiry.clone(), request()),
        addr("other-service"),
        addr("receiver"),
        PAYMENT,
        None,
    )
    .assert_abort();
    submit(
        &env,
        sign(addr("alice"), &ALICE_KEY, expiry, request()),
        addr("service"),
        addr("receiver"),
        PAYMENT,
        None,
    )
    .assert_success();
    env.advance_block();
    assert_eq!(balance(&env, "alice"), INITIAL - PAYMENT);
    assert_eq!(balance(&env, "receiver"), PAYMENT);
}

#[test]
fn a_child_grant_for_another_asset_cannot_debit_the_services_token() {
    let env = setup();
    let expiry = expiry(&env);
    let wrong_asset = PaymentRequest {
        token: addr("other-token"),
        ..request()
    };
    submit(
        &env,
        sign(addr("alice"), &ALICE_KEY, expiry, wrong_asset),
        addr("service"),
        addr("receiver"),
        PAYMENT,
        None,
    )
    .assert_abort();
    env.advance_block();
    assert_eq!(balance(&env, "alice"), INITIAL);
    assert_eq!(balance(&env, "receiver"), 0);
}
