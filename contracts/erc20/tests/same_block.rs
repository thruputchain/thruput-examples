//! The token under Thruput's block-level concurrency.
//!
//! Every transaction in a block executes against the state the previous block
//! committed -- none sees another's writes -- and the block's writes are then
//! merged.  A `Balance` records deltas rather than totals, so debits and
//! credits from different transactions add up, and the non-negativity floor is
//! checked against the *merged* result when the block is packed: a debit that
//! passed its call-time check can still be excluded at commit.  These tests
//! pin down what that means for a token's users, including the one thing an
//! Ethereum-trained intuition gets wrong: an approval cannot be spent in the
//! block that grants it.

use erc20::ERC20Client;
use thruput_erc20_if::ERC20Error;
use thruput_sdk::call::RawCallError;
use thruput_sdk::*;

fn token() -> ContractAddress {
    ContractAddress::named("token")
}
fn admin() -> ContractAddress {
    ContractAddress::named("admin")
}
fn alice() -> ContractAddress {
    ContractAddress::named("alice")
}
fn bob() -> ContractAddress {
    ContractAddress::named("bob")
}
fn carol() -> ContractAddress {
    ContractAddress::named("carol")
}

/// The token deployed, initialized under `admin`, and `minted` units at Alice
/// -- all committed, because the block that wrote them has been advanced past.
fn setup(minted: i128) -> TestEnvironmentHandle {
    let env = TestEnvironment::no_cost();
    erc20::register_mock_contract(&env).deploy_contract_to(&token());

    env.transact(|tx| {
        tx.call(&admin()).run(move || {
            let erc20 = ERC20Client::new(&token());
            erc20.initialize(&admin());
            erc20.mint(&alice(), minted);
        })
    })
    .assert_success();
    env.advance_block();
    env
}

fn transfer(
    env: &TestEnvironmentHandle,
    from: ContractAddress,
    to: ContractAddress,
    amount: i128,
) -> TransactResult {
    env.transact(|tx| {
        tx.call(&from)
            .run(move || ERC20Client::new(&token()).transfer(&to, amount))
    })
}

fn balance_of(env: &TestEnvironmentHandle, who: ContractAddress) -> i128 {
    let result = env.transact(|tx| {
        tx.call(&admin())
            .run(move || ERC20Client::new(&token()).get_balance_of(&who))
    });
    result.assert_success();
    result.assert_return_as::<i128>()
}

fn total_supply(env: &TestEnvironmentHandle) -> i128 {
    let result = env.transact(|tx| {
        tx.call(&admin())
            .run(|| ERC20Client::new(&token()).total_supply())
    });
    result.assert_success();
    result.assert_return_as::<i128>()
}

#[track_caller]
fn assert_too_large(result: &TransactResult) {
    result.assert_abort();
    match into_root_call_result::<()>(result) {
        Err(RawCallError::Exception(error)) => {
            assert_eq!(error.try_as::<ERC20Error>(), Some(ERC20Error::TooLarge));
        }
        other => panic!("expected ERC20Error::TooLarge, got {other:?}"),
    }
}

// A transfer's effect is committed state only once its block is over: a read
// in the same block sees the balances the block began with.
#[test]
fn a_read_in_the_same_block_sees_the_snapshot() {
    let env = setup(100);

    transfer(&env, alice(), bob(), 30).assert_success();
    assert_eq!(balance_of(&env, bob()), 0, "not yet");
    assert_eq!(balance_of(&env, alice()), 100);

    env.advance_block();
    assert_eq!(balance_of(&env, bob()), 30);
    assert_eq!(balance_of(&env, alice()), 70);
}

// Two debits of one account in one block both land when the balance covers
// their sum: each is a delta, and the deltas add.
#[test]
fn same_block_debits_merge_when_the_balance_covers_them() {
    let env = setup(100);

    transfer(&env, alice(), bob(), 30).assert_success();
    transfer(&env, alice(), carol(), 50).assert_success();
    env.advance_block();

    assert_eq!(balance_of(&env, alice()), 20);
    assert_eq!(balance_of(&env, bob()), 30);
    assert_eq!(balance_of(&env, carol()), 50);
}

// When they do not, the second one's frame still succeeds -- it checked the
// balance the block began with, which covered it alone -- but the merged
// debits overdraw, so it fails at commit and is excluded from the block.
// Submitted again in the next block, against the balance the first debit left,
// it is refused at call time with the token's own error.
#[test]
fn the_debit_that_overdraws_at_commit_is_excluded_not_reverted() {
    let env = setup(100);

    transfer(&env, alice(), bob(), 60).assert_success();
    transfer(&env, alice(), carol(), 60).assert_commit_failed_nondeterministically();
    env.advance_block();

    assert_eq!(balance_of(&env, alice()), 40);
    assert_eq!(balance_of(&env, bob()), 60);
    assert_eq!(balance_of(&env, carol()), 0);

    assert_too_large(&transfer(&env, alice(), carol(), 60));
}

// Credits merge too: a transfer and a mint to the same account in one block,
// and two mints in one block to the supply.  A credit is a lazy delta, so no
// number of them to one account conflict.
#[test]
fn same_block_credits_merge() {
    let env = setup(100);

    transfer(&env, alice(), bob(), 30).assert_success();
    env.transact(|tx| {
        tx.call(&admin())
            .run(|| ERC20Client::new(&token()).mint(&bob(), 50))
    })
    .assert_success();
    env.transact(|tx| {
        tx.call(&admin())
            .run(|| ERC20Client::new(&token()).mint(&carol(), 7))
    })
    .assert_success();
    env.advance_block();

    assert_eq!(balance_of(&env, bob()), 80);
    assert_eq!(balance_of(&env, carol()), 7);
    assert_eq!(total_supply(&env), 157);
}

// An approval granted in a block is not spendable until the next: the spender's
// `transfer_from` reads the allowance the block began with, which is zero, and
// is refused deterministically.  The approval and the spend need separate
// blocks -- or one transaction, where the spend sees the approval as its own
// pending write.
#[test]
fn an_approval_is_not_spendable_in_its_own_block() {
    let env = setup(100);

    env.transact(|tx| {
        tx.call(&alice())
            .run(|| ERC20Client::new(&token()).adjust_allowance(&bob(), 40))
    })
    .assert_success();

    let spend = |env: &TestEnvironmentHandle| {
        env.transact(|tx| {
            tx.call(&bob())
                .run(|| ERC20Client::new(&token()).transfer_from(&alice(), &carol(), 40))
        })
    };
    assert_too_large(&spend(&env));

    env.advance_block();
    spend(&env).assert_success();
    env.advance_block();
    assert_eq!(balance_of(&env, carol()), 40);
    assert_eq!(balance_of(&env, alice()), 60);
}

// The spender and the owner can each spend the owner's balance in the same
// block; what is checked at commit is that the balance covers both.
#[test]
fn an_allowance_spend_merges_with_the_owners_own_debit() {
    let env = setup(100);

    env.transact(|tx| {
        tx.call(&alice())
            .run(|| ERC20Client::new(&token()).adjust_allowance(&bob(), 40))
    })
    .assert_success();
    env.advance_block();

    env.transact(|tx| {
        tx.call(&bob())
            .run(|| ERC20Client::new(&token()).transfer_from(&alice(), &carol(), 40))
    })
    .assert_success();
    transfer(&env, alice(), bob(), 60).assert_success();
    // ... and one more debit, which would be fine alone, overdraws the merge.
    transfer(&env, alice(), bob(), 1).assert_commit_failed_nondeterministically();
    env.advance_block();

    assert_eq!(balance_of(&env, alice()), 0);
    assert_eq!(balance_of(&env, bob()), 60);
    assert_eq!(balance_of(&env, carol()), 40);
}
