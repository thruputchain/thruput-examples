//! RPC integration test for the `erc20` contract.
//!
//! The common machinery — signing and submitting transactions through the
//! funded native account of the test's key, polling for receipts, and failure
//! diagnostics — lives in the `integration-test` crate. This file only
//! describes the contract-specific calls and the lifecycle they exercise.
//!
//! It also demonstrates a requirement that is easy to meet and easy to miss: a
//! new allowance on the *native* HOG token needs that contract to hold a
//! storage reserve. See
//! [`native_hog_allowance_needs_a_storage_reserve`].
//!
//! Run it with `groundhog test --integration`.

use std::time::Duration;

use groundhog_xdr::types::ContractAddress;
use integration_test::{
    Harness, InvocationOptions, SubmissionOutcome, decode_return, encode, native_account,
};

const INTERFACE: &str = "ERC20";
const VERSION: &str = "0.1.51";

#[tokio::test]
async fn erc20_lifecycle_over_rpc() {
    let token = Erc20::from_env();

    // The harness's native account is the caller of every transaction below,
    // so it becomes the token administrator and the source of transfers.
    let admin = token.0.wallet();
    let recipient = native_account(1);

    // Fresh deploy: total supply starts at zero (this also confirms the
    // contract is reachable before we initialize it).
    token.initialize(&admin).await;
    assert_eq!(
        token.total_supply().await,
        0,
        "fresh contract has no supply"
    );

    // Mint to the administrator and confirm supply and balance move together.
    token.mint(&admin, 1_000).await;
    assert_eq!(
        token.total_supply().await,
        1_000,
        "supply reflects the mint"
    );
    assert_eq!(
        token.balance_of(&admin).await,
        1_000,
        "admin holds the minted tokens"
    );

    // Transfer some away; both balances should update, supply should not.
    token.transfer(&recipient, 400).await;
    assert_eq!(token.balance_of(&admin).await, 600, "admin balance debited");
    assert_eq!(
        token.balance_of(&recipient).await,
        400,
        "recipient balance credited"
    );
    assert_eq!(
        token.total_supply().await,
        1_000,
        "transfers do not change supply"
    );
}

/// Contract-specific calls layered over the shared [`Harness`].
struct Erc20(Harness);

impl Erc20 {
    fn from_env() -> Self {
        Self(Harness::from_env(INTERFACE, VERSION))
    }

    async fn initialize(&self, administrator: &ContractAddress) {
        self.0.invoke("initialize", encode(administrator)).await;
    }

    async fn mint(&self, receiver: &ContractAddress, amount: i128) {
        self.0.invoke("mint", encode(&(*receiver, amount))).await;
    }

    async fn transfer(&self, receiver: &ContractAddress, amount: i128) {
        self.0
            .invoke("transfer", encode(&(*receiver, amount)))
            .await;
    }

    async fn total_supply(&self) -> i128 {
        decode_return(&self.0.invoke("total_supply", Vec::new()).await)
    }

    async fn balance_of(&self, owner: &ContractAddress) -> i128 {
        decode_return(&self.0.invoke("get_balance_of", encode(owner)).await)
    }
}

const NATIVE_INTERFACE: (&str, &str) = ("ERC20", "0.1.3");
const NATIVE_STORAGE_RESERVE: i128 = 10_000_000;
/// Enough HOG for a fresh account's first transfer: the recipient pays for the
/// balance item it gains out of what it receives (1,234 under the devnode's
/// default prices), so a smaller first transfer cannot run.
const NEW_ACCOUNT_TRANSFER: i128 = 10_000;

fn native_hog() -> ContractAddress {
    let mut bytes = [0u8; 32];
    bytes[31] = 1;
    ContractAddress::from(bytes)
}

fn options() -> InvocationOptions {
    InvocationOptions {
        receipt_timeout: Duration::from_secs(15),
        ..InvocationOptions::default()
    }
}

/// A new allowance on the native HOG token needs the native contract to hold a
/// storage reserve of its own.
///
/// An allowance is a new storage item, and a contract pays for its own storage
/// out of its own HOG.  The native token is no exception -- but on a fresh node
/// it starts with nothing, so the first allowance anyone tries to create cannot
/// be paid for.  It never gets a receipt: the scheduler reports it as needing a
/// retry, with an executor error and no mention of storage, so the cause is
/// easy to miss.
///
/// The remedy is to transfer HOG *to the native token's own address* first.
#[tokio::test]
async fn native_hog_allowance_needs_a_storage_reserve() {
    let (interface, version) = NATIVE_INTERFACE;
    let hog = Harness::from_env(interface, version).retarget(native_hog(), interface, version);

    // The control.  Moving HOG to a fresh account commits, so the account,
    // signing, entrypoint IDs and node are all in order.
    let spender = native_account(1);
    let transfer = hog
        .submit(
            "transfer",
            encode(&(spender, NEW_ACCOUNT_TRANSFER)),
            options(),
        )
        .await
        .expect("submitting transfer");
    assert!(
        matches!(transfer, SubmissionOutcome::Committed(_)),
        "a native HOG transfer should commit, but got {}",
        describe(&transfer)
    );

    // Unreserved, the same account cannot be granted an allowance.
    let before = hog
        .submit("adjust_allowance", encode(&(spender, 1i128)), options())
        .await
        .expect("submitting adjust_allowance");
    assert!(
        matches!(before, SubmissionOutcome::Retry { .. }),
        "without a reserve, a new allowance should fail in the scheduler, but got {}",
        describe(&before)
    );

    // Give the native token the reserve its own storage needs.
    let reserve = hog
        .submit(
            "transfer",
            encode(&(native_hog(), NATIVE_STORAGE_RESERVE)),
            options(),
        )
        .await
        .expect("submitting the reserve transfer");
    assert!(
        matches!(reserve, SubmissionOutcome::Committed(_)),
        "funding the native token should commit, but got {}",
        describe(&reserve)
    );

    // Now the same operation works.  The attempt above left the scheduler, so
    // this creates the same new allowance row it could not.
    let after = hog
        .submit("adjust_allowance", encode(&(spender, 1i128)), options())
        .await
        .expect("submitting adjust_allowance after funding");
    assert!(
        matches!(after, SubmissionOutcome::Committed(_)),
        "with a reserve, a new allowance should commit, but got {}",
        describe(&after)
    );
}

fn describe(outcome: &SubmissionOutcome) -> String {
    match outcome {
        SubmissionOutcome::Committed(_) => "committed".to_owned(),
        SubmissionOutcome::Failed(receipt) => format!("committed but failed: {:?}", receipt.status),
        SubmissionOutcome::Pending { .. } => "still pending when the timeout elapsed".to_owned(),
        SubmissionOutcome::Expired { .. } => "expired before committing".to_owned(),
        SubmissionOutcome::Invalid { reason, .. } => format!("rejected by the scheduler: {reason}"),
        SubmissionOutcome::Retry { error, .. } => {
            format!("failed in the scheduler, to be resubmitted: {error:?}")
        }
        SubmissionOutcome::Dropped { error, .. } => format!("dropped by the scheduler: {error:?}"),
    }
}
