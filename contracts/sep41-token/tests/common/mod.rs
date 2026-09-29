//! SEP-41's behaviour, as scenarios that run against both builds of the
//! token: the native one (`tests/test_native.rs`, under `cargo test`) and the
//! RV32 artifact (`tests/test_rv32.rs`, under `groundhog test`).
//!
//! Every transaction in a Groundhog block runs against the state the previous
//! block committed, so a scenario ends the block, with [`TestToken::commit`],
//! before it reads what a transaction wrote.

use core::panic::UnwindSafe;
use sdk::xdr::{ReadXDROwned, WriteXDR};
use sdk::*;
use sep41_token::{TokenAdminClient, TokenAdminError};
use sep41_token_if::*;

pub const DEPLOYER: Address = Address::new([0x10; 32]);
pub const ADMIN: Address = Address::new([0x20; 32]);
pub const ALICE: Address = Address::new([0x30; 32]);
pub const BOB: Address = Address::new([0x40; 32]);
pub const CAROL: Address = Address::new([0x50; 32]);
/// An address with no role, which reads the token.
pub const OUTSIDER: Address = Address::new([0x60; 32]);

pub const DECIMALS: u32 = 7;
pub const NAME: &str = "Example Token";
pub const SYMBOL: &str = "EXT";
/// Alice's balance when a scenario starts.
pub const MINTED: i128 = 1_000;

/// Declares a `#[test]` for each scenario, running it against a fresh token
/// from `$token`, a `fn() -> TestToken`. Attributes given before `$token` go
/// on every test.
macro_rules! scenarios {
    ($(#[$attr:meta])* $token:path) => {
        $crate::common::scenarios!(@tests [$(#[$attr])*] $token;
            initialize_sets_the_metadata_once,
            balances_and_allowances_start_at_zero,
            mint_credits_to_and_emits_mint,
            transfer_moves_the_amount_and_emits_transfer,
            transfer_to_a_muxed_address_credits_the_address,
            zero_amounts_move_and_emit_events,
            each_function_is_authorized_by_the_address_it_spends_for,
            negative_amounts_are_rejected,
            spending_more_than_the_balance_fails,
            a_balance_cannot_exceed_i128_max,
            approve_overwrites_the_allowance_and_emits_approve,
            approve_rejects_a_past_live_until_ledger_unless_revoking,
            an_allowance_expires_after_its_live_until_ledger,
            transfer_from_spends_the_allowance_but_not_its_expiry,
            spending_more_than_the_allowance_or_the_balance_fails,
            burn_destroys_the_amount_and_emits_burn,
            burn_from_spends_the_allowance_and_emits_burn,
            clawback_burns_and_emits_only_clawback,
            an_approval_is_spendable_from_the_next_ledger,
            an_approval_is_spendable_in_its_own_transaction,
            spends_in_one_ledger_cannot_exceed_the_allowance,
            replacing_and_spending_an_allowance_in_one_ledger_do_not_merge,
        );
    };
    (@tests $attrs:tt $token:path; $($scenario:ident),* $(,)?) => {
        $($crate::common::scenarios!(@test $attrs $token, $scenario);)*
    };
    (@test [$($attr:tt)*] $token:path, $scenario:ident) => {
        #[test]
        $($attr)*
        fn $scenario() {
            $crate::common::$scenario(&$token());
        }
    };
}
pub(crate) use scenarios;

/// A token deployed and initialized with [`ADMIN`] as its administrator, with
/// [`MINTED`] minted to [`ALICE`], all committed.
pub struct TestToken {
    pub env: TestEnvironmentHandle,
    pub address: Address,
}

impl TestToken {
    /// Deploys the token from `contract`, a contract `env` holds.
    pub fn deploy(env: TestEnvironmentHandle, contract: SHA256Hash) -> Self {
        // One transaction, so that nobody can initialize the token first.
        let deployed = env.transact(|tx| {
            tx.call(&DEPLOYER).run(move || {
                let token = deploy_contract(&SHA256Hash::new([0x77; 32]), &contract);
                TokenAdminClient::new(&token).initialize(
                    &ADMIN,
                    DECIMALS,
                    string(NAME),
                    string(SYMBOL),
                );
                token
            })
        });
        deployed.assert_success();
        let token = Self {
            address: deployed.assert_return_as(),
            env,
        };
        token.env.advance_block();

        token.commit(&token.admin(&ADMIN, |client| client.mint(&ALICE, MINTED)));
        token
    }

    /// Calls the token's SEP-41 interface as `caller`, in a transaction in
    /// the current ledger.
    pub fn call<R: WriteXDR>(
        &self,
        caller: &Address,
        f: impl FnOnce(TokenClient) -> R + UnwindSafe,
    ) -> TransactResult {
        let address = self.address;
        self.env
            .transact(|tx| tx.call(caller).run(move || f(TokenClient::new(&address))))
    }

    /// Calls the token's administrator interface as `caller`, in a
    /// transaction in the current ledger.
    pub fn admin<R: WriteXDR>(
        &self,
        caller: &Address,
        f: impl FnOnce(TokenAdminClient) -> R + UnwindSafe,
    ) -> TransactResult {
        let address = self.address;
        self.env.transact(|tx| {
            tx.call(caller)
                .run(move || f(TokenAdminClient::new(&address)))
        })
    }

    /// Ends the current ledger, committing `result`'s transaction, which must
    /// have succeeded.
    #[track_caller]
    pub fn commit(&self, result: &TransactResult) {
        result.assert_success();
        self.next_ledger();
    }

    /// Ends the current ledger.
    pub fn next_ledger(&self) {
        self.env.advance_block();
    }

    /// The current ledger number: the block height.
    pub fn ledger(&self) -> u32 {
        let result = self
            .env
            .transact(|tx| tx.call(&OUTSIDER).run(|| *get_block_height()));
        result.assert_success();
        u32::try_from(result.assert_return_as::<i64>()).unwrap()
    }

    /// Reads the token through its SEP-41 interface.
    #[track_caller]
    pub fn read<R: WriteXDR + ReadXDROwned>(
        &self,
        f: impl FnOnce(TokenClient) -> R + UnwindSafe,
    ) -> R {
        let result = self.call(&OUTSIDER, f);
        result.assert_success();
        result.assert_return_as()
    }

    #[track_caller]
    pub fn balance(&self, id: &Address) -> i128 {
        let id = *id;
        self.read(move |client| client.balance(&id))
    }

    #[track_caller]
    pub fn allowance(&self, from: &Address, spender: &Address) -> i128 {
        let (from, spender) = (*from, *spender);
        self.read(move |client| client.allowance(&from, &spender))
    }

    /// Alice approves Bob to spend `amount` until `live_until_ledger`, and
    /// the ledger ends.
    #[track_caller]
    pub fn approve_bob(&self, amount: i128, live_until_ledger: u32) {
        self.commit(&self.call(&ALICE, move |client| {
            client.approve(&ALICE, &BOB, amount, live_until_ledger)
        }));
    }
}

pub fn string(value: &str) -> String {
    String::try_from(value).unwrap()
}

/// Asserts that `result`'s call threw `expected`, so its transaction changed
/// nothing and emitted nothing.
#[track_caller]
pub fn assert_throws<E>(result: &TransactResult, expected: E)
where
    E: Exn + ReadXDROwned + PartialEq + core::fmt::Debug,
{
    assert_eq!(result.assert_abort_as::<E>(), expected);
    result.assert_no_events();
}

// ---- Metadata --------------------------------------------------------------

/// `initialize` sets `decimals`, `name` and `symbol`, and can be called once.
pub fn initialize_sets_the_metadata_once(token: &TestToken) {
    assert_eq!(
        token.read(|client| (client.decimals(), client.name(), client.symbol())),
        (DECIMALS, string(NAME), string(SYMBOL)),
    );

    let again = token.admin(&ADMIN, |client| {
        client.initialize(&BOB, 18, string("Other Token"), string("OTH"))
    });
    assert_throws(&again, TokenAdminError::AlreadyInitialized);
}

// ---- Balances --------------------------------------------------------------

/// An address with no balance has a balance of 0, and a spender with no
/// allowance an allowance of 0.
pub fn balances_and_allowances_start_at_zero(token: &TestToken) {
    assert_eq!(token.balance(&BOB), 0);
    assert_eq!(token.allowance(&ALICE, &BOB), 0);
}

/// `mint` increases the balance of `to`, and emits `mint`.
pub fn mint_credits_to_and_emits_mint(token: &TestToken) {
    let mint = token.admin(&ADMIN, |client| client.mint(&BOB, 500));
    mint.assert_event_count(1);
    mint.assert_event::<Mint<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), BOB.as_ref());
        assert_eq!(event.payload().amount, 500);
        assert_eq!(event.payload().to_muxed_id, None);
    });
    token.commit(&mint);

    assert_eq!(token.balance(&BOB), 500);
}

/// `transfer` moves `amount` from `from` to `to`, and emits `transfer`.
pub fn transfer_moves_the_amount_and_emits_transfer(token: &TestToken) {
    let transfer = token.call(&ALICE, |client| client.transfer(&ALICE, BOB.into(), 250));
    transfer.assert_event_count(1);
    transfer.assert_event::<Transfer<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ALICE.as_ref());
        assert_eq!(event.topic(2).unwrap(), BOB.as_ref());
        assert_eq!(event.payload().amount, 250);
        assert_eq!(event.payload().to_muxed_id, None);
    });
    token.commit(&transfer);

    assert_eq!(token.balance(&ALICE), MINTED - 250);
    assert_eq!(token.balance(&BOB), 250);
}

/// A transfer to a muxed address credits the address, and its event carries
/// the address and the muxed ID separately.
pub fn transfer_to_a_muxed_address_credits_the_address(token: &TestToken) {
    let to = MuxedAddress {
        address: BOB,
        id: Some(42),
    };
    let transfer = token.call(&ALICE, move |client| client.transfer(&ALICE, to, 250));
    transfer.assert_event_count(1);
    transfer.assert_event::<Transfer<'_>>(0, |event| {
        assert_eq!(event.topic(2).unwrap(), BOB.as_ref());
        assert_eq!(event.payload().amount, 250);
        assert_eq!(event.payload().to_muxed_id, Some(42));
    });
    token.commit(&transfer);

    assert_eq!(token.balance(&BOB), 250);
}

/// A zero amount is not negative: moving it succeeds and emits the event.
pub fn zero_amounts_move_and_emit_events(token: &TestToken) {
    let transfer = token.call(&BOB, |client| client.transfer(&BOB, ALICE.into(), 0));
    transfer.assert_event::<Transfer<'_>>(0, |event| {
        assert_eq!(event.payload().amount, 0);
    });
    let burn = token.call(&BOB, |client| client.burn(&BOB, 0));
    burn.assert_event::<Burn<'_>>(0, |event| {
        assert_eq!(event.payload().amount, 0);
    });
    let transfer_from = token.call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, 0));
    transfer_from.assert_event::<Transfer<'_>>(0, |event| {
        assert_eq!(event.payload().amount, 0);
    });
    token.commit(&transfer_from);

    assert_eq!(token.balance(&ALICE), MINTED);
    assert_eq!(token.balance(&BOB), 0);
}

/// Each function is authorized by the address whose tokens or allowance it
/// spends, or by the administrator, and that address must be the caller.
pub fn each_function_is_authorized_by_the_address_it_spends_for(token: &TestToken) {
    assert_throws(
        &token.call(&BOB, |client| client.transfer(&ALICE, BOB.into(), 1)),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.call(&BOB, |client| client.approve(&ALICE, &BOB, 1, u32::MAX)),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.call(&BOB, |client| client.burn(&ALICE, 1)),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.call(&CAROL, |client| {
            client.transfer_from(&BOB, &ALICE, &CAROL, 1)
        }),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.call(&CAROL, |client| client.burn_from(&BOB, &ALICE, 1)),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.admin(&BOB, |client| client.mint(&BOB, 1)),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.admin(&BOB, |client| client.clawback(&ALICE, 1)),
        TokenError::Unauthorized,
    );
}

/// No function takes a negative amount.
pub fn negative_amounts_are_rejected(token: &TestToken) {
    let ledger = token.ledger();
    assert_throws(
        &token.call(&ALICE, |client| client.transfer(&ALICE, BOB.into(), -1)),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.call(&ALICE, move |client| {
            client.approve(&ALICE, &BOB, -1, ledger)
        }),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, -1)),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.call(&ALICE, |client| client.burn(&ALICE, -1)),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.call(&BOB, |client| client.burn_from(&BOB, &ALICE, -1)),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.admin(&ADMIN, |client| client.mint(&BOB, -1)),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.admin(&ADMIN, |client| client.clawback(&ALICE, -1)),
        TokenError::NegativeAmount,
    );
}

/// Spending more than the balance fails, and moves nothing.
pub fn spending_more_than_the_balance_fails(token: &TestToken) {
    assert_throws(
        &token.call(&ALICE, |client| {
            client.transfer(&ALICE, BOB.into(), MINTED + 1)
        }),
        TokenError::InsufficientBalance,
    );
    assert_throws(
        &token.call(&ALICE, |client| client.burn(&ALICE, MINTED + 1)),
        TokenError::InsufficientBalance,
    );
    assert_throws(
        &token.admin(&ADMIN, |client| client.clawback(&ALICE, MINTED + 1)),
        TokenError::InsufficientBalance,
    );
    token.next_ledger();

    assert_eq!(token.balance(&ALICE), MINTED);
}

/// A balance holds at most `i128::MAX`, the largest amount there is.
pub fn a_balance_cannot_exceed_i128_max(token: &TestToken) {
    token.commit(&token.admin(&ADMIN, |client| client.mint(&BOB, i128::MAX)));

    assert_throws(
        &token.admin(&ADMIN, |client| client.mint(&BOB, 1)),
        TokenError::BalanceOverflow,
    );
    assert_throws(
        &token.call(&ALICE, |client| client.transfer(&ALICE, BOB.into(), 1)),
        TokenError::BalanceOverflow,
    );
}

// ---- Allowances ------------------------------------------------------------

/// `approve` sets the allowance, and emits `approve`. Calling it again
/// replaces the allowance rather than adding to it, and the allowance may
/// exceed the balance: it is a spending limit, not a reservation.
pub fn approve_overwrites_the_allowance_and_emits_approve(token: &TestToken) {
    let live_until_ledger = token.ledger() + 10;
    let approve = token.call(&ALICE, move |client| {
        client.approve(&ALICE, &BOB, 100, live_until_ledger)
    });
    approve.assert_event_count(1);
    approve.assert_event::<Approve<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ALICE.as_ref());
        assert_eq!(event.topic(2).unwrap(), BOB.as_ref());
        assert_eq!(event.payload().amount, 100);
        assert_eq!(event.payload().live_until_ledger, live_until_ledger);
    });
    token.commit(&approve);
    assert_eq!(token.allowance(&ALICE, &BOB), 100);

    token.approve_bob(30, live_until_ledger);
    assert_eq!(token.allowance(&ALICE, &BOB), 30);

    token.approve_bob(MINTED * 5, live_until_ledger);
    assert_eq!(token.allowance(&ALICE, &BOB), MINTED * 5);
}

/// `live_until_ledger` cannot be before the current ledger, unless the
/// allowance is being set to 0.
pub fn approve_rejects_a_past_live_until_ledger_unless_revoking(token: &TestToken) {
    let current = token.ledger();
    assert_throws(
        &token.call(&ALICE, move |client| {
            client.approve(&ALICE, &BOB, 1, current - 1)
        }),
        TokenError::LiveUntilLedgerInPast,
    );

    token.approve_bob(1, current);
    token.approve_bob(0, current - 1);
}

/// An allowance lasts through its `live_until_ledger`, and is then treated as
/// an allowance of 0.
pub fn an_allowance_expires_after_its_live_until_ledger(token: &TestToken) {
    let live_until_ledger = token.ledger() + 1;
    token.approve_bob(100, live_until_ledger);
    assert_eq!(token.ledger(), live_until_ledger);
    assert_eq!(token.allowance(&ALICE, &BOB), 100);

    token.next_ledger();
    assert_eq!(token.allowance(&ALICE, &BOB), 0);
    assert_throws(
        &token.call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, 1)),
        TokenError::InsufficientAllowance,
    );
}

/// `transfer_from` moves the amount as `transfer` would, and reduces the
/// allowance by it without changing when the allowance expires.
pub fn transfer_from_spends_the_allowance_but_not_its_expiry(token: &TestToken) {
    let live_until_ledger = token.ledger() + 2;
    token.approve_bob(100, live_until_ledger);

    let transfer = token.call(&BOB, |client| {
        client.transfer_from(&BOB, &ALICE, &CAROL, 40)
    });
    transfer.assert_event_count(1);
    transfer.assert_event::<Transfer<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ALICE.as_ref());
        assert_eq!(event.topic(2).unwrap(), CAROL.as_ref());
        assert_eq!(event.payload().amount, 40);
        assert_eq!(event.payload().to_muxed_id, None);
    });
    token.commit(&transfer);

    assert_eq!(token.balance(&ALICE), MINTED - 40);
    assert_eq!(token.balance(&CAROL), 40);
    assert_eq!(token.allowance(&ALICE, &BOB), 60);

    assert_eq!(token.ledger(), live_until_ledger);
    token.next_ledger();
    assert_eq!(token.allowance(&ALICE, &BOB), 0);
}

/// `transfer_from` and `burn_from` fail when the allowance is less than the
/// amount, and when `from`'s balance is, however large the allowance.
pub fn spending_more_than_the_allowance_or_the_balance_fails(token: &TestToken) {
    let live_until_ledger = token.ledger() + 10;
    token.approve_bob(100, live_until_ledger);
    assert_throws(
        &token.call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, 101)),
        TokenError::InsufficientAllowance,
    );
    assert_throws(
        &token.call(&BOB, |client| client.burn_from(&BOB, &ALICE, 101)),
        TokenError::InsufficientAllowance,
    );

    token.approve_bob(MINTED * 2, live_until_ledger);
    assert_throws(
        &token.call(&BOB, |client| {
            client.transfer_from(&BOB, &ALICE, &BOB, MINTED + 1)
        }),
        TokenError::InsufficientBalance,
    );
    assert_throws(
        &token.call(&BOB, |client| client.burn_from(&BOB, &ALICE, MINTED + 1)),
        TokenError::InsufficientBalance,
    );
    token.next_ledger();

    assert_eq!(token.allowance(&ALICE, &BOB), MINTED * 2);
}

/// `burn` destroys the amount, and emits `burn`.
pub fn burn_destroys_the_amount_and_emits_burn(token: &TestToken) {
    let burn = token.call(&ALICE, |client| client.burn(&ALICE, 100));
    burn.assert_event_count(1);
    burn.assert_event::<Burn<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ALICE.as_ref());
        assert_eq!(event.payload().amount, 100);
    });
    token.commit(&burn);

    assert_eq!(token.balance(&ALICE), MINTED - 100);
}

/// `burn_from` burns as `burn` would, and reduces the allowance by the amount.
pub fn burn_from_spends_the_allowance_and_emits_burn(token: &TestToken) {
    token.approve_bob(50, token.ledger() + 10);

    let burn = token.call(&BOB, |client| client.burn_from(&BOB, &ALICE, 20));
    burn.assert_event_count(1);
    burn.assert_event::<Burn<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ALICE.as_ref());
        assert_eq!(event.payload().amount, 20);
    });
    token.commit(&burn);

    assert_eq!(token.balance(&ALICE), MINTED - 20);
    assert_eq!(token.allowance(&ALICE, &BOB), 30);
}

/// `clawback` burns from the holder without their authorization, and emits
/// `clawback` alone: no `burn` or `transfer` accompanies it.
pub fn clawback_burns_and_emits_only_clawback(token: &TestToken) {
    let clawback = token.admin(&ADMIN, |client| client.clawback(&ALICE, 300));
    clawback.assert_event_count(1);
    clawback.assert_event::<Clawback<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ALICE.as_ref());
        assert_eq!(event.payload().amount, 300);
    });
    token.commit(&clawback);

    assert_eq!(token.balance(&ALICE), MINTED - 300);
}

// ---- Allowances under Groundhog's concurrency ------------------------------

/// An approval takes effect for other transactions when its ledger commits:
/// a `transfer_from` in another transaction of the same ledger reads the
/// allowance the ledger began with.
pub fn an_approval_is_spendable_from_the_next_ledger(token: &TestToken) {
    let live_until_ledger = token.ledger() + 10;
    token
        .call(&ALICE, move |client| {
            client.approve(&ALICE, &BOB, 100, live_until_ledger)
        })
        .assert_success();

    let spend = || token.call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, 100));
    assert_throws(&spend(), TokenError::InsufficientAllowance);

    token.next_ledger();
    token.commit(&spend());
    assert_eq!(token.balance(&BOB), 100);
}

/// Within the transaction that makes it, an approval can be spent at once:
/// here Alice approves Bob and then calls him, and he spends the allowance.
pub fn an_approval_is_spendable_in_its_own_transaction(token: &TestToken) {
    let address = token.address;
    let live_until_ledger = token.ledger() + 10;
    let result = token.env.transact(|tx| {
        tx.call(&ALICE)
            .run_continuable(move |alice| {
                TokenClient::new(&address).approve(&ALICE, &BOB, 100, live_until_ledger);
                alice
                    .child_call(&BOB)
                    .run(move || TokenClient::new(&address).transfer_from(&BOB, &ALICE, &BOB, 100))
                    .assert_success();
                FrameAction::Close
            })
            .finish()
    });
    result.assert_event_count(2);
    token.commit(&result);

    assert_eq!(token.balance(&BOB), 100);
    assert_eq!(token.allowance(&ALICE, &BOB), 0);
}

/// Each spend in a ledger is checked against the allowance the ledger began
/// with, and the ledger's spends are checked together when it commits: a
/// spend that would take the allowance below 0 is excluded from the ledger,
/// to be retried in the next.
pub fn spends_in_one_ledger_cannot_exceed_the_allowance(token: &TestToken) {
    token.approve_bob(100, token.ledger() + 10);

    token
        .call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, 60))
        .assert_success();
    token
        .call(&BOB, |client| {
            client.transfer_from(&BOB, &ALICE, &CAROL, 60)
        })
        .assert_commit_failed_nondeterministically();
    token.next_ledger();

    assert_eq!(token.allowance(&ALICE, &BOB), 40);
    assert_eq!(token.balance(&BOB), 60);
    assert_eq!(token.balance(&CAROL), 0);
}

/// `approve` replaces the allowance, so it cannot commit in the same ledger
/// as a spend of the allowance it replaces: the later of the two is excluded
/// from the ledger, to be retried in the next.
pub fn replacing_and_spending_an_allowance_in_one_ledger_do_not_merge(token: &TestToken) {
    let live_until_ledger = token.ledger() + 10;
    token.approve_bob(100, live_until_ledger);

    token
        .call(&ALICE, move |client| {
            client.approve(&ALICE, &BOB, 30, live_until_ledger)
        })
        .assert_success();
    token
        .call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, 60))
        .assert_commit_failed_nondeterministically();
    token.next_ledger();

    assert_eq!(token.allowance(&ALICE, &BOB), 30);
    assert_eq!(token.balance(&BOB), 0);

    token
        .call(&BOB, |client| client.transfer_from(&BOB, &ALICE, &BOB, 10))
        .assert_success();
    token
        .call(&ALICE, move |client| {
            client.approve(&ALICE, &BOB, 50, live_until_ledger)
        })
        .assert_commit_failed_nondeterministically();
    token.next_ledger();

    assert_eq!(token.allowance(&ALICE, &BOB), 20);
    assert_eq!(token.balance(&BOB), 10);
}
