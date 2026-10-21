use alloc::vec::Vec;
use thruput_sdk::storage::{Balance, Map, NNInt, Value};
use thruput_sdk::*;

pub type Text = heapless::String<160>;
pub type Description = heapless::String<512>;
pub type OptionText = heapless::String<96>;
pub type Options = VecM<OptionText, 6>;
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

// Keep each Value below the localnode's 1 KiB bytestring limit.
#[contract_type]
#[derive(Clone, Debug)]
pub struct PollHeader {
    pub admin: ContractAddress,
    pub status: Status,
    pub title: Text,
    pub description: Description,
    pub question_count: u32,
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
    polls: Map<u64, Value<PollHeader>>,
    question_titles: Map<u64, Map<u32, Value<Text>>>,
    option_counts: Map<u64, Map<u32, Value<u32>>>,
    options: Map<u64, Map<u32, Map<u32, Value<OptionText>>>>,
    answers: Map<u64, Map<ContractAddress, Map<u32, Value<u32>>>>,
    participants: Map<u64, Map<ContractAddress, Value<bool>>>,
    participant_counts: Map<u64, Balance>,
    totals: Map<u64, Map<u32, Map<u32, Balance>>>,
}

impl Voting {
    fn header(&self, id: u64) -> PollHeader {
        self.polls
            .at(&id)
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(VotingError::NotFound))
    }

    fn require_admin(&self, id: u64, status: Status) -> PollHeader {
        let poll = self.header(id);
        ensure(poll.admin == get_caller(), VotingError::NotAdmin);
        ensure(poll.status == status, VotingError::WrongStatus);
        poll
    }

    fn save_definition(&mut self, id: u64, admin: ContractAddress, definition: Definition) {
        self.polls.at_mut(&id).set_exclusive(&PollHeader {
            admin,
            status: Status::Draft,
            title: definition.title,
            description: definition.description,
            question_count: definition.questions.len() as u32,
        });
        for (index, question) in definition.questions.iter().enumerate() {
            let index = index as u32;
            self.question_titles
                .at_mut(&id)
                .at_mut(&index)
                .set_exclusive(&question.title);
            self.option_counts
                .at_mut(&id)
                .at_mut(&index)
                .set_exclusive(&(question.options.len() as u32));
            for (option, text) in question.options.iter().enumerate() {
                self.options
                    .at_mut(&id)
                    .at_mut(&index)
                    .at_mut(&(option as u32))
                    .set_exclusive(text);
            }
        }
        // Old slots beyond the current counts are inaccessible and can be reused
        // by later draft edits. At most 8 × 6 option slots exist per poll.
    }

    fn validate(definition: &Definition) {
        ensure(
            !definition.title.trim().is_empty(),
            VotingError::InvalidDefinition,
        );
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
        Self::validate(&definition);
        let id = self.count();
        ensure(id < u64::MAX, VotingError::LimitReached);
        self.poll_count.set(i128::from(id) + 1);
        let admin = get_caller();
        self.save_definition(id, admin, definition);
        log_event(&PollCreated { id, admin });
        id
    }

    pub fn edit_poll(&mut self, id: u64, definition: Definition) {
        let poll = self.require_admin(id, Status::Draft);
        Self::validate(&definition);
        self.save_definition(id, poll.admin, definition);
    }

    pub fn open_poll(&mut self, id: u64) {
        let mut poll = self.require_admin(id, Status::Draft);
        ensure(poll.question_count > 0, VotingError::InvalidDefinition);
        poll.status = Status::Open;
        self.polls.at_mut(&id).set_exclusive(&poll);
    }

    pub fn close_poll(&mut self, id: u64) {
        let mut poll = self.require_admin(id, Status::Open);
        poll.status = Status::Closed;
        self.polls.at_mut(&id).set_exclusive(&poll);
    }

    pub fn vote(&mut self, id: u64, question: u32, option: u32) {
        let poll = self.header(id);
        ensure(poll.status == Status::Open, VotingError::WrongStatus);
        ensure(
            question < poll.question_count,
            VotingError::InvalidSelection,
        );
        ensure(
            option < self.option_counts.at(&id).at(&question).get(),
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

    pub fn get_poll(&self, id: u64) -> PollHeader {
        self.header(id)
    }

    pub fn get_question(&self, id: u64, question: u32) -> Question {
        ensure(
            question < self.header(id).question_count,
            VotingError::InvalidSelection,
        );
        let mut options = Vec::new();
        for option in 0..self.option_counts.at(&id).at(&question).get() {
            options.push(self.options.at(&id).at(&question).at(&option).get());
        }
        Question {
            title: self.question_titles.at(&id).at(&question).get(),
            options: VecM(options),
        }
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
