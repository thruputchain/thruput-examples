use fenwick::Fenwick;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::deletable::Deletable;
use thruput_sdk::storage::{Map, NNInt, Node, Value};
use thruput_sdk::*;

const NANOS_PER_SECOND: u64 = 1_000_000_000;

/// The data items a payee's running totals take: [`Payee`]'s four integers. The first stream to a
/// payee creates them.
const PAYEE_ITEMS: i128 = 4;

/// What a stream contract is, fixed when it starts.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    /// The token every stream here pays in. The native token works like any other.
    pub token: ContractAddress,

    /// The native tokens a payer deposits for each data item its stream creates in this
    /// contract's storage.
    ///
    /// Storage is paid for out of this contract's native tokens. A stream creates its record, the
    /// payee's running totals if it is the payee's first, and whichever nodes of the payee's
    /// schedule its end is the first to reach. The record's bond comes back when the record is
    /// deleted; the rest stay, as the payee's totals and schedule do. Set the bond to at least the
    /// network's cost of a stream's record, the largest of these items. A bond of zero leaves this
    /// contract paying for every item anyone's stream creates, so that anyone could drain its
    /// native tokens with streams.
    pub item_bond: i128,
}

/// The contract's settings: its terms, and the second its clock starts at.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub terms: Terms,

    /// The block time `initialize` ran at, in Unix seconds. A payee's schedule counts seconds from
    /// here, and holds 2^32 - 1 of them, about 136 years.
    pub origin: u64,
}

/// One stream: `rate` tokens a second, to `payee`, from `start` until `end`, in Unix seconds.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Flow {
    pub payee: ContractAddress,
    pub rate: u64,
    pub start: u64,
    pub end: u64,
}

/// What cancelling a stream did.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cancellation {
    /// What the payee keeps: what the stream paid until now.
    pub paid: i128,

    /// What the payer got back: what had not streamed yet.
    pub refund: i128,
}

#[contract_exception]
pub enum StreamError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// The terms name no token, or this contract, or a negative bond.
    InvalidTerms = 3,
    /// The contract does not hold the native tokens `initialize` asks for.
    ReserveTooSmall = 4,
    /// A stream must pay at least a token a second.
    ZeroRate = 5,
    /// A stream must last at least a second.
    ZeroDuration = 6,
    /// A stream must end within the contract's 136 years.
    TooLong = 7,
    /// A deposit too large to represent.
    TooLarge = 8,
    /// A stream cannot pay this contract: nobody could withdraw it.
    InvalidPayee = 9,
    /// The payer already has an open stream with this id.
    IdInUse = 10,
    NoSuchStream = 11,
    /// The payee has nothing to withdraw.
    NothingOwed = 12,
    /// A time before the current block's: what is earned by then can no longer be read.
    InThePast = 13,
}

#[derive(Event, Clone, Debug)]
pub struct Opened {
    #[topic]
    pub payer: ContractAddress,
    #[topic]
    pub payee: ContractAddress,
    pub id: u64,
    pub flow: Flow,
}

#[derive(Event, Clone, Debug)]
pub struct Cancelled {
    #[topic]
    pub payer: ContractAddress,
    #[topic]
    pub payee: ContractAddress,
    pub id: u64,
    pub paid: i128,
    pub refund: i128,
}

#[derive(Event, Clone, Debug)]
pub struct Withdrawn {
    #[topic]
    pub payee: ContractAddress,
    pub amount: i128,
}

/// The native tokens a stream contract must hold when it starts: a bond for its config, and one
/// more, for a cancel to refund a record's bond from. The record a cancel deletes gives its
/// deposit back only when the cancel commits, so the refund has to come out of tokens the contract
/// already holds. Cancels in the same block do not add up: each commit gets its own deposit back.
pub fn reserve_needed(item_bond: i128) -> i128 {
    item_bond.saturating_mul(2)
}

/// Everything a payee is owed, as sums that streams only ever add to or take back from.
///
/// The payee's rate is a step function of time: each stream raises it by its rate at its start,
/// and lowers it again at its end. What the payee has earned by second `t` is the area under that
/// function up to `t`. A step of height `r` at second `s` adds `r * (t - s)` to it by `t`, so each
/// set of steps comes down to two sums: of the heights, and of each height times its second.
///
/// Every stream has already started, so every rise counts at any time the contract can ask
/// about: those are two plain sums. Ends are in the future, and a rise has to be cancelled out
/// only once its end has passed: those are prefix sums over time, which is what a [`Fenwick`] tree
/// gives.
#[derive(Storage)]
pub struct Payee {
    // Over the streams to this payee that have not been cancelled: the sum of their rates, and of
    // each rate times its start, in seconds since the origin.
    rates: NNInt,
    starts: NNInt,

    // The same streams' ends, by second: each one's rate, and its rate times its end.
    ends: Fenwick,
    end_weights: Fenwick,

    // What the streams cancelled so far paid before they stopped.
    settled: NNInt,

    // What the payee has taken out. Written only by the payee's withdrawals, exclusively.
    withdrawn: NNInt,
}

impl Payee {
    /// What the payee has earned by second `at`, the withdrawn amounts included. `at` must be no
    /// earlier than any stream's start.
    fn earned(&self, at: u32) -> i128 {
        let at_ = I256::from(i128::from(at));

        // As if no stream ended: each has paid `rate * (at - start)`.
        let running = I256::from(read(&self.rates)) * at_ - I256::from(read(&self.starts));
        // Each that has ended by `at` overcounts that by `rate * (at - end)`.
        let ended = self.ends.prefix_sum(at) * at_ - self.end_weights.prefix_sum(at);

        // Every term is under 2^170, so none overflows. The total is no more than was paid in, so
        // it fits an `i128`.
        i128::try_from(I256::from(read(&self.settled)) + running - ended)
            .or_throw(StreamError::TooLarge)
    }

    /// The sum of the rates of the streams still running at second `at`. No more than `rates`, so
    /// it fits.
    fn rate(&self, at: u32) -> i128 {
        i128::try_from(I256::from(read(&self.rates)) - self.ends.prefix_sum(at))
            .or_throw(StreamError::TooLarge)
    }

    fn owed(&self, at: u32) -> i128 {
        self.earned(at) - read(&self.withdrawn)
    }

    fn exists(&self) -> bool {
        self.withdrawn.try_get().none_if_missing().is_some()
    }
}

// A total, as of the block's start plus this transaction's changes. One that has never been
// written is zero.
fn read(total: &NNInt) -> i128 {
    total.try_get().none_if_missing().unwrap_or(0)
}

/// Payment streams: `rate` tokens a second, from a payer to a payee, prepaid. The payee withdraws
/// what has streamed whenever it likes, and the payer can cancel at any time, and is refunded what
/// has not.
///
/// A payee's streams are kept together, as sums that each stream only adds to and takes back from:
/// see [`Payee`]. So what any payee is owed takes a fixed amount of work to find, however many
/// streams pay it, and nothing needs to run when a stream starts paying, or stops. Opening and
/// cancelling streams never conflict with each other, nor with the payee's withdrawals: any number
/// of them land in one block.
#[thruput_sdk::storage]
pub struct Stream {
    config: Value<Config>,
    payees: Map<ContractAddress, Node<Payee>>,

    // Each payer's open streams, by the id the payer gave each one. Created with an exclusive lock
    // and deleted with one, so each is opened once and cancelled once.
    flows: Map<ContractAddress, Map<u64, Value<Flow>>>,
}

impl Stream {
    fn load(&self) -> Config {
        self.config
            .try_get()
            .none_if_missing()
            .or_throw(StreamError::NotInitialized)
    }

    fn now() -> u64 {
        get_block_timepoint().into_inner() / NANOS_PER_SECOND
    }

    // `time`, in seconds since the origin: an index into a payee's schedule.
    fn second(config: &Config, time: u64) -> u32 {
        // Blocks only move forward in time, so the origin is never in the future.
        u32::try_from(time - config.origin)
            .ok()
            .filter(|s| *s <= fenwick::MAX_INDEX)
            .or_throw(StreamError::TooLong)
    }

    fn native_from(payer: &ContractAddress, amount: i128) {
        if amount > 0 {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
                payer,
                &get_current_address(),
                amount,
            );
        }
    }

    fn native_to(to: &ContractAddress, amount: i128) {
        if amount > 0 {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(to, amount);
        }
    }
}

#[contract(
    throws(StreamError, thruput_erc20_if::ERC20Error),
    emits(Opened, Cancelled, Withdrawn)
)]
impl Stream {
    /// Start the contract, streaming `terms.token`. Its clock starts now. Call it in the
    /// transaction that deploys the contract.
    ///
    /// The terms must name a token other than this contract, and a bond that is not negative.
    /// The contract must already hold the native tokens [`reserve_needed`] asks for: send them to
    /// its address before deploying it, or earlier in the same transaction.
    pub fn initialize(&mut self, terms: Terms) {
        ensure(
            self.config.try_get().none_if_missing().is_none(),
            StreamError::AlreadyInitialized,
        );
        let here = get_current_address();
        ensure(
            terms.token != ContractAddress::default()
                && terms.token != here
                && terms.item_bond >= 0,
            StreamError::InvalidTerms,
        );
        ensure(
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&here)
                >= reserve_needed(terms.item_bond),
            StreamError::ReserveTooSmall,
        );

        self.config.set_exclusive(&Config {
            terms,
            origin: Self::now(),
        });
    }

    /// Stream `rate` tokens a second to `payee`, starting now, for `seconds` seconds, under the id
    /// `id`. The whole of it, `rate * seconds`, is taken from the caller now, on an allowance
    /// granted to this contract. Returns the stream.
    ///
    /// It also takes a bond, in native tokens on an allowance of those, for each data item the
    /// stream creates: see [`Terms::item_bond`]. `id` must not name another of the caller's open
    /// streams; once a stream is cancelled, its id is free again.
    pub fn open(&mut self, payee: &ContractAddress, id: u64, rate: u64, seconds: u64) -> Flow {
        let config = self.load();
        let here = get_current_address();
        ensure(*payee != here, StreamError::InvalidPayee);
        ensure(rate > 0, StreamError::ZeroRate);
        ensure(seconds > 0, StreamError::ZeroDuration);
        let deposit = u128::from(rate)
            .checked_mul(u128::from(seconds))
            .and_then(|d| i128::try_from(d).ok())
            .or_throw(StreamError::TooLarge);

        let start = Self::now();
        let end = start.checked_add(seconds).or_throw(StreamError::TooLong);
        let first = Self::second(&config, start);
        let last = Self::second(&config, end);
        let rate_ = i128::from(rate);

        let payer = get_caller();
        let flow = Flow {
            payee: *payee,
            rate,
            start,
            end,
        };

        // The record. Written with an exclusive lock, so that two opens with one id in one block
        // cannot both commit.
        let mut mine = self.flows.at_mut(&payer);
        let mut record = mine.at_mut(&id);
        ensure(
            record.try_get().none_if_missing().is_none(),
            StreamError::IdInUse,
        );
        record.set_exclusive(&flow);
        let mut items = 1;

        let mut to = self.payees.at_mut(payee);
        if !to.exists() {
            // The payee's first stream creates its totals, so no later step has to: not a cancel,
            // and above all not the payee's withdrawal, which locks `withdrawn`. Adding zero
            // creates a total, and merges with any other stream's doing the same in this block.
            to.settled.inc(0);
            to.withdrawn.inc(0);
            items += PAYEE_ITEMS;
        }
        items += i128::from(to.ends.missing_nodes(last).or_throw(StreamError::TooLong));
        items += i128::from(
            to.end_weights
                .missing_nodes(last)
                .or_throw(StreamError::TooLong),
        );

        // The rise, now, and the fall, at the end. Each is a sum of deltas, and reads nothing, so
        // it merges with every other stream's, to this payee or any other.
        to.rates.inc(rate_);
        to.starts.inc(rate_ * i128::from(first));
        to.ends.add(last, rate_).or_throw(StreamError::TooLong);
        to.end_weights
            .add(last, rate_ * i128::from(last))
            .or_throw(StreamError::TooLong);

        ERC20Client::new(&config.terms.token).transfer_from(&payer, &here, deposit);
        Self::native_from(&payer, items.saturating_mul(config.terms.item_bond));

        log_event(&Opened {
            payer,
            payee: *payee,
            id,
            flow,
        });
        flow
    }

    /// Stop the caller's stream `id` now. The payee keeps what has streamed, and the caller gets
    /// back what has not, and the record's bond. A stream that has already ended is just cleared
    /// away, for its bond.
    pub fn cancel(&mut self, id: u64) -> Cancellation {
        let config = self.load();
        let payer = get_caller();

        let mut mine = self.flows.at_mut(&payer);
        let mut record = mine.at_mut(&id);
        let flow = record
            .try_get()
            .none_if_missing()
            .or_throw(StreamError::NoSuchStream);
        // The exclusive delete is what makes a cancel happen once. Two cancels in one block both
        // read the record, but both cannot delete it: the second conflicts, and cannot commit.
        // (A plain delete would not do: two deletes of one key do not conflict.)
        record.delete_exclusive();

        let now = Self::now();
        let mut cancellation = Cancellation::default();
        if now < flow.end {
            let rate = i128::from(flow.rate);
            let start = Self::second(&config, flow.start);
            let end = Self::second(&config, flow.end);
            let stopped = Self::second(&config, now);
            cancellation = Cancellation {
                paid: rate * i128::from(stopped - start),
                refund: rate * i128::from(end - stopped),
            };

            // Book what the stream paid, and take it out of the running totals and the schedule.
            // Everything taken back was added in an earlier block, so no total can go below zero,
            // whatever else this block does.
            let mut to = self.payees.at_mut(&flow.payee);
            to.settled.inc(cancellation.paid);
            to.rates.inc(-rate);
            to.starts.inc(-rate * i128::from(start));
            to.ends.subtract(end, rate).or_throw(StreamError::TooLong);
            to.end_weights
                .subtract(end, rate * i128::from(end))
                .or_throw(StreamError::TooLong);

            if cancellation.refund > 0 {
                ERC20Client::new(&config.terms.token).transfer(&payer, cancellation.refund);
            }
        }
        Self::native_to(&payer, config.terms.item_bond);

        log_event(&Cancelled {
            payer,
            payee: flow.payee,
            id,
            paid: cancellation.paid,
            refund: cancellation.refund,
        });
        cancellation
    }

    /// Pay the caller everything its streams have paid it and it has not yet withdrawn. Returns
    /// the amount.
    ///
    /// One withdrawal a block: it writes the payee's withdrawn total with an exclusive lock, so a
    /// second in the same block cannot commit. Without that, two withdrawals in one block would
    /// read the same total, and pay the same amount twice.
    pub fn withdraw(&mut self) -> i128 {
        let config = self.load();
        let payee = get_caller();
        let now = Self::second(&config, Self::now());

        let mut mine = self.payees.at_mut_exclusive(&payee);
        let amount = mine.owed(now);
        ensure(amount > 0, StreamError::NothingOwed);
        mine.withdrawn.inc(amount);

        ERC20Client::new(&config.terms.token).transfer(&payee, amount);
        log_event(&Withdrawn { payee, amount });
        amount
    }

    pub fn config(&self) -> Config {
        self.load()
    }

    /// What `payee` could withdraw now.
    pub fn owed(&self, payee: &ContractAddress) -> i128 {
        let config = self.load();
        self.payees
            .at(payee)
            .owed(Self::second(&config, Self::now()))
    }

    /// What `payee` could withdraw at `time`, in Unix seconds, if no stream to it were opened or
    /// cancelled before then.
    pub fn owed_at(&self, payee: &ContractAddress, time: u64) -> i128 {
        let config = self.load();
        ensure(time >= Self::now(), StreamError::InThePast);
        self.payees.at(payee).owed(Self::second(&config, time))
    }

    /// The tokens a second `payee` is being paid now: the sum of the rates of its streams that are
    /// running.
    pub fn rate(&self, payee: &ContractAddress) -> i128 {
        let config = self.load();
        self.payees
            .at(payee)
            .rate(Self::second(&config, Self::now()))
    }

    /// `payer`'s stream `id`, if it is open.
    pub fn flow(&self, payer: &ContractAddress, id: u64) -> Option<Flow> {
        self.flows.at(payer).at(&id).try_get().none_if_missing()
    }
}
