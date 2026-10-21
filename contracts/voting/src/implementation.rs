use thruput_sdk::storage::{Balance, Map, NNInt, Value};
use thruput_sdk::*;

pub type Text = heapless::String<160>;
pub type Description = heapless::String<512>;
pub type Options = VecM<Text, 6>;
pub type Questions = VecM<Question, 8>;

#[contract_type]
#[derive(Clone, Debug)]
pub struct Question {
    pub title: Text,
    pub options: Options,
}

#[contract_type]
#[derive(Clone, Debug)]
pub struct Definition {
    pub title: Text,
    pub description: Description,
    pub questions: Questions,
}

#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Draft = 0,
    Open = 1,
    Closed = 2,
}

#[contract_type]
#[derive(Clone, Debug)]
pub struct Poll {
    pub admin: ContractAddress,
    pub status: Status,
    pub definition: Definition,
}

#[contract_exception]
pub enum VotingError {
    NotFound = 1,
    NotAdmin = 2,
    WrongStatus = 3,
    InvalidDefinition = 4,
    InvalidSelection = 5,
    AlreadyAnswered = 6,
    LimitReached = 7,
}

#[derive(Event, Clone, Debug)]
pub struct PollCreated {
    #[topic]
    pub id: u64,
    pub admin: ContractAddress,
}

#[thruput_sdk::storage]
pub struct Voting {
    // Creation is deliberately serialized. Voting does not write this counter.
    poll_count: NNInt,
    polls: Map<u64, Value<Poll>>,
    answers: Map<u64, Map<ContractAddress, Map<u32, Value<u32>>>>,
    participants: Map<u64, Map<ContractAddress, Value<bool>>>,
    participant_counts: Map<u64, Balance>,
    totals: Map<u64, Map<u32, Map<u32, Balance>>>,
}

impl Voting {
    fn require_admin(&self, id: u64, status: Status) -> Poll {
        let poll = self.get_poll(id);
        ensure(poll.admin == get_caller(), VotingError::NotAdmin);
        ensure(poll.status == status, VotingError::WrongStatus);
        poll
    }

    fn validate(definition: &Definition, opening: bool) {
        ensure(
            !definition.title.trim().is_empty(),
            VotingError::InvalidDefinition,
        );
        if opening {
            ensure(
                !definition.questions.is_empty(),
                VotingError::InvalidDefinition,
            );
        }
        for question in definition.questions.iter() {
            ensure(
                !question.title.trim().is_empty(),
                VotingError::InvalidDefinition,
            );
            ensure(question.options.len() >= 2, VotingError::InvalidDefinition);
            for (index, option) in question.options.iter().enumerate() {
                ensure(!option.trim().is_empty(), VotingError::InvalidDefinition);
                ensure(
                    !question.options[..index]
                        .iter()
                        .any(|other| other.trim() == option.trim()),
                    VotingError::InvalidDefinition,
                );
            }
        }
    }
}

#[contract(throws = VotingError, emits(PollCreated))]
impl Voting {
    pub fn create_poll(&mut self, definition: Definition) -> u64 {
        Self::validate(&definition, false);
        let id = self.count();
        ensure(id < u64::MAX, VotingError::LimitReached);
        self.poll_count.set(i128::from(id) + 1);
        let admin = get_caller();
        self.polls.at_mut(&id).set_exclusive(&Poll {
            admin,
            status: Status::Draft,
            definition,
        });
        log_event(&PollCreated { id, admin });
        id
    }

    pub fn edit_poll(&mut self, id: u64, definition: Definition) {
        let mut poll = self.require_admin(id, Status::Draft);
        Self::validate(&definition, false);
        poll.definition = definition;
        self.polls.at_mut(&id).set_exclusive(&poll);
    }

    pub fn open_poll(&mut self, id: u64) {
        let mut poll = self.require_admin(id, Status::Draft);
        Self::validate(&poll.definition, true);
        poll.status = Status::Open;
        self.polls.at_mut(&id).set_exclusive(&poll);
    }

    pub fn close_poll(&mut self, id: u64) {
        let mut poll = self.require_admin(id, Status::Open);
        poll.status = Status::Closed;
        self.polls.at_mut(&id).set_exclusive(&poll);
    }

    pub fn vote(&mut self, id: u64, question: u32, option: u32) {
        let poll = self.get_poll(id);
        ensure(poll.status == Status::Open, VotingError::WrongStatus);
        let question_data = poll
            .definition
            .questions
            .get(question as usize)
            .unwrap_or_else(|| throw(VotingError::InvalidSelection));
        ensure(
            (option as usize) < question_data.options.len(),
            VotingError::InvalidSelection,
        );
        let voter = get_caller();
        ensure(
            self.answer(id, &voter, question).is_none(),
            VotingError::AlreadyAnswered,
        );
        // Exclusive writes prevent two submissions by the same wallet from both winning.
        self.answers
            .at_mut(&id)
            .at_mut(&voter)
            .at_mut(&question)
            .set_exclusive(&option);
        if self
            .participants
            .at(&id)
            .at(&voter)
            .try_get()
            .none_if_missing()
            .is_none()
        {
            self.participants
                .at_mut(&id)
                .at_mut(&voter)
                .set_exclusive(&true);
            self.participant_counts.at_mut(&id).increase(1);
        }
        // Different voters' increases can merge without replacing a shared tally.
        self.totals
            .at_mut(&id)
            .at_mut(&question)
            .at_mut(&option)
            .increase(1);
    }

    pub fn count(&self) -> u64 {
        self.poll_count.try_get().none_if_missing().unwrap_or(0) as u64
    }

    pub fn get_poll(&self, id: u64) -> Poll {
        self.polls
            .at(&id)
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(VotingError::NotFound))
    }

    pub fn answer(&self, id: u64, voter: &ContractAddress, question: u32) -> Option<u32> {
        self.answers
            .at(&id)
            .at(voter)
            .at(&question)
            .try_get()
            .none_if_missing()
    }

    pub fn tally(&self, id: u64, question: u32, option: u32) -> i128 {
        self.totals.at(&id).at(&question).at(&option).get()
    }

    pub fn participant_count(&self, id: u64) -> i128 {
        self.participant_counts.at(&id).get()
    }
}
