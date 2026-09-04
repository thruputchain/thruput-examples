use cross_trait_throws::*;
use sdk::*;

static LEDGER_NONCE: SHA256Hash = sdk::sha256_static!("CROSS_TRAIT_THROWS_LEDGER");
static CALLER_NONCE: SHA256Hash = sdk::sha256_static!("CROSS_TRAIT_THROWS_CALLER");

hash_ident! { static OPERATOR: ContractAddress; }

fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = cross_trait_throws::register_mock_contract(&env);
    (env, *contract.as_hash())
}

/// Deploy one ledger, initialize it, and fund the caller's account.
fn deployed_ledger(contract_hash: &SHA256Hash, funded: u128) -> ContractAddress {
    let addr = deploy_contract(&LEDGER_NONCE, contract_hash);
    LedgerAdminClient::new(&addr).initialize(&OPERATOR);
    if funded > 0 {
        LedgerClient::new(&addr).deposit(funded);
    }
    addr
}

// ── Both interfaces work on the one deployed contract ────────────────────

#[test]
fn both_interfaces_answer_at_the_same_address() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deployed_ledger(&contract_hash, 100);

            let ledger = LedgerClient::new(&addr);
            let pausable = PausableClient::new(&addr);

            assert_eq!(ledger.balance(), 100);
            assert!(!pausable.paused());

            ledger.withdraw(40);
            assert_eq!(ledger.balance(), 60);
        })
    })
    .assert_success();
}

// ── Each interface's own declared error ──────────────────────────────────

#[test]
fn ledger_throws_its_own_declared_error() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deployed_ledger(&contract_hash, 10);
            let ledger = LedgerClient::new(&addr);

            let err = ledger.try_withdraw(25).unwrap_err();
            assert_eq!(
                err.try_as(),
                Some(LedgerError::InsufficientFunds { requested: 25 })
            );
        })
    })
    .assert_success();
}

#[test]
fn pausable_throws_its_own_declared_error() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        tx.call(&ContractAddress::named("caller")).run(|| {
            let addr = deployed_ledger(&contract_hash, 0);

            // The caller is not the operator, so pausing is refused.
            let err = PausableClient::new(&addr).try_pause().unwrap_err();
            assert_eq!(err.try_as(), Some(PauseError::NotOperator));
        })
    })
    .assert_success();
}

// ── The point of the example ─────────────────────────────────────────────
// A `LedgerClient` call comes back carrying `PauseError`, which the `Ledger`
// interface never declared. The caller decodes it anyway.

#[test]
fn ledger_client_catches_the_peer_interfaces_error() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        tx.call(&OPERATOR).run(|| {
            let addr = deployed_ledger(&contract_hash, 100);
            PausableClient::new(&addr).pause();

            // `withdraw` is a `Ledger` method and `Ledger` throws
            // `LedgerError` — but what arrives is `Pausable`'s error type.
            let err = LedgerClient::new(&addr).try_withdraw(10).unwrap_err();

            // It is not a LedgerError, and saying so costs one selector
            // comparison rather than a decode attempt.
            assert_eq!(err.try_as::<LedgerError>(), None);
            assert_eq!(err.try_as(), Some(PauseError::EnforcedPause));
        })
    })
    .assert_success();
}

/// The same catch written as one `match_exn!` over both interfaces' errors,
/// which is how a caller that handles several outcomes writes it.
#[test]
fn match_exn_matches_both_interfaces_errors_as_peers() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        tx.call(&OPERATOR).run(|| {
            let addr = deployed_ledger(&contract_hash, 100);
            let ledger = LedgerClient::new(&addr);
            let pausable = PausableClient::new(&addr);

            let classify = |amount: u128| -> &'static str {
                match ledger.try_withdraw(amount) {
                    Ok(()) => "ok",
                    Err(CallError::Fault(_)) => "fault",
                    Err(e) => match_exn!(e, {
                        LedgerError::InsufficientFunds { .. } => "insufficient",
                        LedgerError::ZeroAmount => "zero",
                        // Declared by `Pausable`, not by `Ledger`.
                        PauseError::EnforcedPause => "paused",
                        _ => "other",
                    }),
                }
            };

            assert_eq!(classify(10), "ok");
            assert_eq!(classify(0), "zero");
            assert_eq!(classify(10_000), "insufficient");

            pausable.pause();
            assert_eq!(classify(10), "paused");

            pausable.unpause();
            assert_eq!(classify(10), "ok");
        })
    })
    .assert_success();
}

// ── The same dispatch, run in guest code ─────────────────────────────────

#[test]
fn withdraw_from_dispatches_in_guest_code() {
    let (env, contract_hash) = setup();

    env.transact(|tx| {
        tx.call(&OPERATOR).run(|| {
            let target = deployed_ledger(&contract_hash, 100);
            let caller = deploy_contract(&CALLER_NONCE, &contract_hash);
            let admin = LedgerAdminClient::new(&caller);

            // The caller contract holds no funds on `target`, so its own
            // withdrawals are refused for lack of balance.
            assert_eq!(admin.withdraw_from(&target, 0), 3, "zero amount");
            assert_eq!(admin.withdraw_from(&target, 5), 2, "insufficient funds");

            PausableClient::new(&target).pause();

            // Paused now outranks the empty balance: `withdraw` checks the
            // pause state first, and the error crosses the interface line.
            assert_eq!(admin.withdraw_from(&target, 5), 4, "paused");
        })
    })
    .assert_success();
}
