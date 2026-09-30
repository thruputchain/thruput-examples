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

pub const DEPLOYER: ContractAddress = ContractAddress::new([0x10; 32]);
pub const ADMIN: ContractAddress = ContractAddress::new([0x20; 32]);
pub const ALICE: ContractAddress = ContractAddress::new([0x30; 32]);
pub const BOB: ContractAddress = ContractAddress::new([0x40; 32]);
/// An address with no role, which reads the token.
pub const OUTSIDER: ContractAddress = ContractAddress::new([0x60; 32]);

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
            balances_start_at_zero,
            mint_credits_to_and_emits_mint,
            transfer_moves_the_amount_and_emits_transfer,
            burn_destroys_the_amount_and_emits_burn,
            zero_amounts_move_and_emit_events,
            each_function_is_authorized_by_the_address_it_spends_for,
            negative_amounts_are_rejected,
            spending_more_than_the_balance_fails,
            a_balance_cannot_exceed_i128_max,
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
    pub address: ContractAddress,
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
        caller: &ContractAddress,
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
        caller: &ContractAddress,
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
    pub fn balance(&self, id: &ContractAddress) -> i128 {
        let id = *id;
        self.read(move |client| client.balance(&id))
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

/// An address with no balance has a balance of 0.
pub fn balances_start_at_zero(token: &TestToken) {
    assert_eq!(token.balance(&BOB), 0);
}

/// `mint` increases the balance of `to`, and emits `mint`.
pub fn mint_credits_to_and_emits_mint(token: &TestToken) {
    let mint = token.admin(&ADMIN, |client| client.mint(&BOB, 500));
    mint.assert_event_count(1);
    mint.assert_event::<Mint<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), BOB.as_ref());
        assert_eq!(event.payload().amount, 500);
    });
    token.commit(&mint);

    assert_eq!(token.balance(&BOB), 500);
}

/// `transfer` moves `amount` from `from` to `to`, and emits `transfer`.
pub fn transfer_moves_the_amount_and_emits_transfer(token: &TestToken) {
    let transfer = token.call(&ALICE, |client| client.transfer(&ALICE, &BOB, 250));
    transfer.assert_event_count(1);
    transfer.assert_event::<Transfer<'_>>(0, |event| {
        assert_eq!(event.topic(1).unwrap(), ALICE.as_ref());
        assert_eq!(event.topic(2).unwrap(), BOB.as_ref());
        assert_eq!(event.payload().amount, 250);
    });
    token.commit(&transfer);

    assert_eq!(token.balance(&ALICE), MINTED - 250);
    assert_eq!(token.balance(&BOB), 250);
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

/// A zero amount is not negative: moving it succeeds and emits the event.
pub fn zero_amounts_move_and_emit_events(token: &TestToken) {
    let transfer = token.call(&BOB, |client| client.transfer(&BOB, &ALICE, 0));
    transfer.assert_event::<Transfer<'_>>(0, |event| {
        assert_eq!(event.payload().amount, 0);
    });
    let burn = token.call(&BOB, |client| client.burn(&BOB, 0));
    burn.assert_event::<Burn<'_>>(0, |event| {
        assert_eq!(event.payload().amount, 0);
    });
    token.commit(&burn);

    assert_eq!(token.balance(&ALICE), MINTED);
    assert_eq!(token.balance(&BOB), 0);
}

/// Each function is authorized by the address whose tokens it spends, or by
/// the administrator, and that address must be the caller.
pub fn each_function_is_authorized_by_the_address_it_spends_for(token: &TestToken) {
    assert_throws(
        &token.call(&BOB, |client| client.transfer(&ALICE, &BOB, 1)),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.call(&BOB, |client| client.burn(&ALICE, 1)),
        TokenError::Unauthorized,
    );
    assert_throws(
        &token.admin(&BOB, |client| client.mint(&BOB, 1)),
        TokenError::Unauthorized,
    );
}

/// No function takes a negative amount.
pub fn negative_amounts_are_rejected(token: &TestToken) {
    assert_throws(
        &token.call(&ALICE, |client| client.transfer(&ALICE, &BOB, -1)),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.call(&ALICE, |client| client.burn(&ALICE, -1)),
        TokenError::NegativeAmount,
    );
    assert_throws(
        &token.admin(&ADMIN, |client| client.mint(&BOB, -1)),
        TokenError::NegativeAmount,
    );
}

/// Spending more than the balance fails, and moves nothing.
pub fn spending_more_than_the_balance_fails(token: &TestToken) {
    assert_throws(
        &token.call(&ALICE, |client| client.transfer(&ALICE, &BOB, MINTED + 1)),
        TokenError::InsufficientBalance,
    );
    assert_throws(
        &token.call(&ALICE, |client| client.burn(&ALICE, MINTED + 1)),
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
        &token.call(&ALICE, |client| client.transfer(&ALICE, &BOB, 1)),
        TokenError::BalanceOverflow,
    );
}
