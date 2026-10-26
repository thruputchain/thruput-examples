use airdrop::*;
use erc20::{ERC20Client, ERC20MetadataClient};
use std::panic::AssertUnwindSafe;
use thruput_sdk::*;

struct Fixture {
    env: TestEnvironmentHandle,
    _code: MockContract,
    _token_code: MockContract,
    admin: ContractAddress,
    alice: ContractAddress,
    bob: ContractAddress,
    address: ContractAddress,
    tokens: [ContractAddress; 2],
}

impl Fixture {
    fn new(restricted: bool, second_balance: i128) -> Self {
        let env = TestEnvironment::no_cost();
        let code = register_mock_contract(&env);
        let token_code = erc20::register_mock_contract(&env);
        let admin = ContractAddress::named("admin");
        let alice = ContractAddress::named("alice");
        let bob = ContractAddress::named("bob");
        let mut address = admin;
        let mut tokens = [admin; 2];
        env.transact(|tx| {
            tx.call(&admin).run(AssertUnwindSafe(|| {
                address = deploy_contract(&sha256_static!("airdrop"), code.as_hash());
                tokens[0] = deploy_contract(&sha256_static!("first"), token_code.as_hash());
                tokens[1] = deploy_contract(&sha256_static!("second"), token_code.as_hash());
                for (index, token) in tokens.iter().enumerate() {
                    ERC20MetadataClient::new(token).initialize(&admin, None, None, Some(6));
                    ERC20Client::new(token)
                        .mint(&address, if index == 0 { 1000 } else { second_balance });
                }
                AirdropClient::new(&address).initialize(
                    VecM(
                        tokens
                            .iter()
                            .map(|token| Reward {
                                token: *token,
                                amount: 100,
                            })
                            .collect(),
                    ),
                    VecM(if restricted { vec![alice] } else { vec![] }),
                );
            }))
        })
        .assert_success();
        env.advance_block();
        Self {
            env,
            _code: code,
            _token_code: token_code,
            admin,
            alice,
            bob,
            address,
            tokens,
        }
    }
    fn call(&self, caller: ContractAddress, action: impl FnOnce(AirdropClient)) {
        self.env
            .transact(|tx| {
                tx.call(&caller).run(AssertUnwindSafe(|| {
                    action(AirdropClient::new(&self.address))
                }))
            })
            .assert_success();
        self.env.advance_block();
    }
}

#[test]
fn empty_allowlist_allows_each_wallet_once() {
    let f = Fixture::new(false, 1000);
    for recipient in [f.alice, f.bob] {
        f.call(recipient, |c| {
            assert!(c.eligible(&recipient));
            c.claim();
            assert!(c.has_claimed(&recipient));
            for token in f.tokens {
                assert_eq!(ERC20Client::new(&token).get_balance_of(&recipient), 100);
            }
            assert_eq!(
                c.try_claim().unwrap_err().try_as(),
                Some(AirdropError::AlreadyClaimed)
            );
        });
    }
}

#[test]
fn allowlist_rejects_unqualified_wallet_without_consuming_claim() {
    let f = Fixture::new(true, 1000);
    f.call(f.bob, |c| {
        assert!(!c.eligible(&f.bob));
        assert_eq!(
            c.try_claim().unwrap_err().try_as(),
            Some(AirdropError::NotEligible)
        );
        assert!(!c.has_claimed(&f.bob));
    });
    f.call(f.alice, |c| c.claim());
}

#[test]
fn failed_transfer_rolls_back_all_rewards_and_claim_marker() {
    let f = Fixture::new(false, 0);
    f.call(f.alice, |c| {
        assert!(c.try_claim().is_err());
        assert!(!c.has_claimed(&f.alice));
        assert_eq!(ERC20Client::new(&f.tokens[0]).get_balance_of(&f.alice), 0);
    });
    f.call(f.admin, |_| {
        ERC20Client::new(&f.tokens[1]).mint(&f.address, 100)
    });
    f.call(f.alice, |c| c.claim());
}

#[test]
fn configuration_cannot_be_replaced() {
    let f = Fixture::new(false, 1000);
    f.call(f.admin, |c| {
        assert_eq!(
            c.try_initialize(VecM(vec![]), VecM(vec![]))
                .unwrap_err()
                .try_as(),
            Some(AirdropError::AlreadyInitialized)
        )
    });
}

#[test]
fn concurrent_duplicate_claims_cannot_both_commit() {
    let f = Fixture::new(false, 1000);
    let mut a = f.env.transaction().build();
    let mut b = f.env.transaction().build();
    a.call(&f.alice)
        .run(|| AirdropClient::new(&f.address).claim());
    b.call(&f.alice)
        .run(|| AirdropClient::new(&f.address).claim());
    assert_eq!(a.try_commit_transaction(), TryCommitResult::Ok);
    assert!(matches!(
        b.try_commit_transaction(),
        TryCommitResult::TxNonDeterministicError(_)
    ));
}

#[test]
fn concurrent_distinct_wallets_can_both_claim() {
    let f = Fixture::new(false, 1000);
    let mut a = f.env.transaction().build();
    let mut b = f.env.transaction().build();
    a.call(&f.alice)
        .run(|| AirdropClient::new(&f.address).claim());
    b.call(&f.bob)
        .run(|| AirdropClient::new(&f.address).claim());
    assert_eq!(a.try_commit_transaction(), TryCommitResult::Ok);
    assert_eq!(b.try_commit_transaction(), TryCommitResult::Ok);
}

#[test]
fn invalid_rewards_do_not_initialize_the_contract() {
    let env = TestEnvironment::no_cost();
    let code = register_mock_contract(&env);
    let admin = ContractAddress::named("admin");
    env.transact(|tx| {
        tx.call(&admin).run(AssertUnwindSafe(|| {
            let address = deploy_contract(&sha256_static!("invalid"), code.as_hash());
            let c = AirdropClient::new(&address);
            let reward = Reward {
                token: ContractAddress::named("token"),
                amount: 1,
            };
            for rewards in [
                vec![],
                vec![Reward {
                    amount: 0,
                    ..reward.clone()
                }],
                vec![reward.clone(), reward.clone()],
            ] {
                assert_eq!(
                    c.try_initialize(VecM(rewards), VecM(vec![]))
                        .unwrap_err()
                        .try_as(),
                    Some(AirdropError::InvalidConfiguration)
                );
            }
            c.initialize(VecM(vec![reward]), VecM(vec![]));
            assert!(!c.config().restricted);
        }))
    })
    .assert_success();
}
