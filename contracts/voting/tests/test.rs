use std::panic::AssertUnwindSafe;
use thruput_sdk::*;
use voting::*;

fn definition() -> Definition {
    Definition {
        title: "Community priorities".try_into().unwrap(),
        description: "Choose what comes next".try_into().unwrap(),
        questions: VecM(vec![
            Question {
                title: "What should we build?".try_into().unwrap(),
                options: VecM(vec![
                    "Wallet".try_into().unwrap(),
                    "Explorer".try_into().unwrap()
                ]),
            };
            2
        ]),
    }
}

struct Fixture {
    _code: MockContract,
    env: TestEnvironmentHandle,
    address: ContractAddress,
    admin: ContractAddress,
    voter: ContractAddress,
}

impl Fixture {
    fn new() -> Self {
        let env = TestEnvironment::no_cost();
        let code = register_mock_contract(&env);
        let admin = ContractAddress::named("admin");
        let voter = ContractAddress::named("voter");
        let nonce = sha256_static!("voting");
        let mut address = admin;
        env.transact(|tx| {
            tx.call(&admin).run(AssertUnwindSafe(|| {
                address = deploy_contract(&nonce, code.as_hash());
                VotingClient::new(&address).create_poll(definition());
            }))
        })
        .assert_success();
        env.advance_block();
        Self {
            _code: code,
            env,
            address,
            admin,
            voter,
        }
    }

    fn call(&self, caller: ContractAddress, run: impl FnOnce(VotingClient)) {
        self.env
            .transact(|tx| {
                tx.call(&caller)
                    .run(AssertUnwindSafe(|| run(VotingClient::new(&self.address))))
            })
            .assert_success();
        self.env.advance_block();
    }
}

#[test]
fn lifecycle_and_partial_participation() {
    let f = Fixture::new();
    f.call(f.admin, |c| {
        assert_eq!(c.count(), 1);
        assert_eq!(c.get_poll(0).admin, f.admin);
        assert_eq!(c.get_poll(0).status, Status::Draft);
        assert_eq!(c.tally(0, 0, 0), 0);
        c.open_poll(0);
        c.vote(0, 0, 0);
    });
    f.call(f.voter, |c| {
        assert_eq!(c.answer(0, &f.voter, 0), None);
        c.vote(0, 0, 1);
    });
    f.call(f.voter, |c| {
        c.vote(0, 1, 0);
        assert_eq!(c.answer(0, &f.voter, 0), Some(1));
        assert_eq!(c.participant_count(0), 2);
        assert_eq!(c.tally(0, 0, 0), 1);
        assert_eq!(c.tally(0, 0, 1), 1);
        assert_eq!(c.tally(0, 1, 0), 1);
    });
    f.call(f.admin, |c| {
        c.close_poll(0);
        assert_eq!(c.get_poll(0).status, Status::Closed);
    });
}

#[test]
fn permissions_and_invalid_transitions() {
    let f = Fixture::new();
    f.call(f.voter, |c| {
        assert_eq!(
            c.try_edit_poll(0, definition()).unwrap_err().try_as(),
            Some(VotingError::NotAdmin)
        );
        assert_eq!(
            c.try_open_poll(0).unwrap_err().try_as(),
            Some(VotingError::NotAdmin)
        );
        assert_eq!(
            c.try_close_poll(0).unwrap_err().try_as(),
            Some(VotingError::NotAdmin)
        );
        assert_eq!(
            c.try_vote(0, 0, 0).unwrap_err().try_as(),
            Some(VotingError::WrongStatus)
        );
        assert_eq!(
            c.try_get_poll(99).unwrap_err().try_as(),
            Some(VotingError::NotFound)
        );
    });
    f.call(f.admin, |c| {
        assert_eq!(
            c.try_close_poll(0).unwrap_err().try_as(),
            Some(VotingError::WrongStatus)
        );
        c.open_poll(0);
        assert_eq!(
            c.try_edit_poll(0, definition()).unwrap_err().try_as(),
            Some(VotingError::WrongStatus)
        );
        assert_eq!(
            c.try_open_poll(0).unwrap_err().try_as(),
            Some(VotingError::WrongStatus)
        );
        c.close_poll(0);
        assert_eq!(
            c.try_open_poll(0).unwrap_err().try_as(),
            Some(VotingError::WrongStatus)
        );
        assert_eq!(
            c.try_vote(0, 0, 0).unwrap_err().try_as(),
            Some(VotingError::WrongStatus)
        );
    });
}

#[test]
fn votes_are_final_and_scoped_to_poll_question_and_wallet() {
    let f = Fixture::new();
    f.call(f.admin, |c| {
        assert_eq!(c.create_poll(definition()), 1);
        c.open_poll(0);
        c.open_poll(1);
    });
    f.call(f.voter, |c| {
        assert_eq!(
            c.try_vote(0, 2, 0).unwrap_err().try_as(),
            Some(VotingError::InvalidSelection)
        );
        assert_eq!(
            c.try_vote(0, 0, 2).unwrap_err().try_as(),
            Some(VotingError::InvalidSelection)
        );
        c.vote(0, 0, 0);
    });
    f.call(f.voter, |c| {
        assert_eq!(
            c.try_vote(0, 0, 1).unwrap_err().try_as(),
            Some(VotingError::AlreadyAnswered)
        );
        c.vote(1, 0, 1);
        assert_eq!(c.tally(0, 0, 1), 0);
        assert_eq!(c.participant_count(1), 1);
    });
}

#[test]
fn drafts_can_replace_content_but_opening_requires_questions() {
    let f = Fixture::new();
    f.call(f.admin, |c| {
        let mut draft = definition();
        draft.questions = VecM(vec![]);
        c.edit_poll(0, draft);
        assert_eq!(
            c.try_open_poll(0).unwrap_err().try_as(),
            Some(VotingError::InvalidDefinition)
        );
        c.edit_poll(0, definition());
        c.open_poll(0);
    });
}

#[test]
fn invalid_content_is_rejected() {
    let f = Fixture::new();
    f.call(f.admin, |c| {
        let mut blank = definition();
        blank.title = " ".try_into().unwrap();
        assert_eq!(
            c.try_create_poll(blank).unwrap_err().try_as(),
            Some(VotingError::InvalidDefinition)
        );
        let mut duplicate = definition();
        duplicate.questions.0[0].options.0[1] = " Wallet ".try_into().unwrap();
        assert_eq!(
            c.try_create_poll(duplicate).unwrap_err().try_as(),
            Some(VotingError::InvalidDefinition)
        );
        let mut one_option = definition();
        one_option.questions.0[0].options.0.pop();
        assert_eq!(
            c.try_create_poll(one_option).unwrap_err().try_as(),
            Some(VotingError::InvalidDefinition)
        );
        assert_eq!(c.count(), 1);
    });
}

#[test]
fn concurrent_distinct_wallets_merge_but_duplicate_answers_do_not() {
    for same_wallet in [false, true] {
        let f = Fixture::new();
        f.call(f.admin, |c| c.open_poll(0));
        let mut a = f.env.transaction().build();
        let mut b = f.env.transaction().build();
        a.call(&f.admin)
            .run(|| VotingClient::new(&f.address).vote(0, 0, 0));
        b.call(&if same_wallet { f.admin } else { f.voter })
            .run(|| VotingClient::new(&f.address).vote(0, 0, 0));
        assert_eq!(a.try_commit_transaction(), TryCommitResult::Ok);
        let result = b.try_commit_transaction();
        if same_wallet {
            assert!(matches!(
                result,
                TryCommitResult::TxNonDeterministicError(_)
            ));
        } else {
            assert_eq!(result, TryCommitResult::Ok);
        }
        drop(a);
        drop(b);
        f.env.advance_block();
        f.call(f.admin, |c| {
            let expected = if same_wallet { 1 } else { 2 };
            assert_eq!(c.tally(0, 0, 0), expected);
            assert_eq!(c.participant_count(0), expected);
        });
    }
}
