use thruput_erc20_if::{ERC20Client, ERC20Error};
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::deletable::Deletable;
use thruput_sdk::storage::{Array, CapacityConstraint, Map, Node, Value};
use thruput_sdk::*;

/// The most members a route can pass through between the payer and the payee. A route of
/// `MAX_VIA` members makes `MAX_VIA + 1` hops.
pub const MAX_VIA: u32 = 6;

/// The most routes one payment can be split over.
pub const MAX_ROUTES: u32 = 4;

/// The largest credit limit. Each pair's two rooms add up to its two limits, so no room can
/// overflow.
pub const MAX_LIMIT: i128 = 1 << 100;

/// The members a route passes through, in order from the payer.
pub type Via = VecM<ContractAddress, MAX_VIA>;

/// The routes a payment is split over.
pub type Routes = VecM<Route, MAX_ROUTES>;

/// One path a payment takes, and how much goes along it.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    /// The members between the payer and the payee. Empty if the payee extends credit to the
    /// payer, or owes it.
    pub via: Via,
    pub amount: i128,
}

/// What the network is, fixed when it starts.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// The native tokens a member deposits to open a pair, returned when the pair is closed.
    ///
    /// A pair is three data items in this contract's storage, and storage is paid for out of this
    /// contract's native tokens until it is deleted. The bond makes whoever opens the pair pay for
    /// it instead: set it to at least [`pair_storage_cost`]. A bond of zero leaves the network
    /// paying for every pair anyone opens, so that anyone could drain its native tokens.
    pub pair_bond: i128,
}

/// A credit line, as its creditor sees it.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Line {
    /// How much the debtor may owe the creditor.
    pub limit: i128,

    /// What the debtor owes the creditor, net of what the creditor owes the debtor: negative if
    /// the creditor is the one who owes.
    pub owed: i128,

    /// How much more the debtor may come to owe: `limit - owed`.
    pub room: i128,
}

#[contract_exception]
pub enum CreditError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// A negative pair bond.
    InvalidBond = 3,
    /// The contract does not hold the native tokens `initialize` asks for.
    ReserveTooSmall = 4,
    /// A member cannot extend credit to itself.
    SelfCredit = 5,
    /// A limit that is negative or above [`MAX_LIMIT`], or a limit of zero for a pair that does
    /// not exist yet.
    InvalidLimit = 6,
    /// The limit would be below what the debtor already owes.
    LimitBelowDebt = 7,
    /// A payment with no routes, a route with an amount that is not positive, or a route that
    /// visits a member twice. A payment to oneself must go round at least two others.
    InvalidRoute = 8,
    /// A hop of the payment has no credit line, or not enough room left on it.
    NotEnoughCredit = 9,
    /// An amount too large to represent.
    TooLarge = 10,
    NoSuchPair = 11,
    /// One member of the pair still extends credit to the other.
    CreditExtended = 12,
}

#[derive(Event, Clone, Debug)]
pub struct LineSet {
    #[topic]
    pub creditor: ContractAddress,
    #[topic]
    pub debtor: ContractAddress,
    pub limit: i128,
}

/// A payment. Along each route, every member comes to owe the next one `amount` more (or be owed
/// that much less), from the payer to the payee.
#[derive(Event, Clone, Debug)]
pub struct Paid {
    #[topic]
    pub from: ContractAddress,
    #[topic]
    pub to: ContractAddress,
    pub amount: i128,
    pub routes: Routes,
}

#[derive(Event, Clone, Debug)]
pub struct PairClosed {
    #[topic]
    pub a: ContractAddress,
    #[topic]
    pub b: ContractAddress,
    /// Who opened the pair, and was paid back its bond.
    pub bonder: ContractAddress,
    pub bond: i128,
}

/// The native tokens, in pair bonds, the network must hold when it starts.
///
/// Two bonds. A bond is meant to cover a pair's three data items, and the network stores one
/// small value of its own: one bond covers that. The other is room for `close` to refund a bond:
/// the pair it deletes gives its deposits back only when it commits, so the refund has to come out
/// of tokens the network already holds. Closes in the same block do not add up: each commit gets
/// its own deposits back.
pub fn reserve_needed(pair_bond: i128) -> i128 {
    pair_bond.saturating_mul(2)
}

/// The most bytes a pair's terms can take in storage. Integers are stored in as few bytes as their
/// value needs, so a pair's terms grow as its limits do, up to this.
pub const MAX_TERMS_BYTES: usize = match <PairTerms as __xdrs::cxs::ConstMaxSize>::MAX_SIZE {
    Some(bytes) => bytes,
    None => panic!("a pair's terms have a largest encoding"),
};

/// What storing a pair costs at most, at the network's storage prices: `baseDataItemCost` and
/// `bytestringCostPerByte` in the RPC's storage costs. That is three data items -- the two rooms,
/// and the terms at their largest. A `pair_bond` of at least this keeps every pair paying for
/// itself.
pub fn pair_storage_cost(base_data_item_cost: i128, bytestring_cost_per_byte: i128) -> i128 {
    3 * base_data_item_cost + MAX_TERMS_BYTES as i128 * bytestring_cost_per_byte
}

/// Two members' terms with each other: how far each trusts the other, and who paid to open them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ReadXDR, WriteXDR, __xdrs::ConstXDRSize)]
#[xdrs(crate = "::thruput_sdk::__xdrs")]
struct PairTerms {
    bonder: ContractAddress,
    bond: i128,
    // `limits[s]`: how much the other member may owe member `s`. Member 0 is the lower address.
    limits: [i128; 2],
}

/// A pair of members, stored once whichever of them pays which.
#[derive(Storage, Deletable)]
struct StoredPair {
    // Written by `set_limit` and deleted by `close`, always with an exclusive lock, so two changes
    // to one pair's terms cannot both commit in one block. Payments never read it.
    terms: Value<PairTerms>,

    // `room[s]`: how much more the other member may come to owe member `s`, which is
    // `limits[s]` less what it owes now. A payment from one member to the other takes from the
    // payee's room and gives to the payer's, so the two always add up to the two limits.
    room: Array<CapacityConstraint, 2>,
}

/// A mutual-credit network: money that is nothing but members' credit with each other.
///
/// A member extends credit to another by setting a limit on how much that one may owe it. A
/// payment is a chain of such debts: along a route from the payer to the payee, each member comes
/// to owe the next one the amount more. The members in between owe as much more as they are owed,
/// so only the payer's position and the payee's change. Nothing is issued and nothing is held:
/// every member's position is what it is owed less what it owes, and they add up to zero.
///
/// Each direction of a credit line keeps its *room* -- how much more the debtor may owe -- as a
/// `CapacityConstraint`. A payment never reads and rewrites a balance: it records what it takes
/// from one room and gives to another, at each hop, and the runtime admits a block's payments while
/// every room stays at or above zero. So any number of payments can pass through one member in a
/// block, and none can take a line past its limit, whatever the block holds.
#[thruput_sdk::storage]
pub struct MutualCredit {
    config: Value<Config>,

    // Each pair under its lower address, then its higher.
    pairs: Map<ContractAddress, Map<ContractAddress, Node<StoredPair>>>,
}

// The pair's two members, lower address first.
fn ordered(a: &ContractAddress, b: &ContractAddress) -> (ContractAddress, ContractAddress) {
    if a < b { (*a, *b) } else { (*b, *a) }
}

// Which member of the pair whose lower address is `low` that `member` is.
fn side(member: &ContractAddress, low: &ContractAddress) -> u32 {
    if member == low { 0 } else { 1 }
}

// Take `amount` from `room`, if it has that much in this block: as of the block's start, less what
// this transaction has already taken. That check gives a clear error to what could never fit;
// whether a block's takings fit together is the runtime's check.
fn take(room: &mut CapacityConstraint, amount: i128, error: CreditError) {
    ensure(room.get_remaining_capacity() >= amount, error);
    room.consume_capacity(amount);
}

// Add `amount` to `room`. What a block adds is there from the next block: the runtime checks a
// block's takings against the room as of its start.
fn give(room: &mut CapacityConstraint, amount: i128) {
    room.consume_capacity(-amount);
}

impl MutualCredit {
    fn load(&self) -> Config {
        self.config
            .try_get()
            .none_if_missing()
            .or_throw(CreditError::NotInitialized)
    }

    // A route is a simple path from the payer to the payee: nobody on it twice. A payer paying
    // itself goes round a cycle, through at least two others.
    fn check_route(from: &ContractAddress, to: &ContractAddress, route: &Route) {
        ensure(route.amount > 0, CreditError::InvalidRoute);
        ensure(
            from != to || route.via.len() >= 2,
            CreditError::InvalidRoute,
        );
        for (index, member) in route.via.iter().enumerate() {
            ensure(member != from && member != to, CreditError::InvalidRoute);
            ensure(
                !route.via[..index].contains(member),
                CreditError::InvalidRoute,
            );
        }
    }

    // One hop: `debtor` comes to owe `creditor` `amount` more, or be owed that much less.
    fn hop(&mut self, debtor: &ContractAddress, creditor: &ContractAddress, amount: i128) {
        let (low, high) = ordered(debtor, creditor);
        let mut row = self.pairs.at_mut(&low);
        let mut pair = row.at_mut(&high);
        // The creditor's room is what lets the debtor owe it more. With no pair, it is zero, and
        // the payment is refused before it writes anything.
        take(
            &mut pair.room.at_mut(side(creditor, &low)),
            amount,
            CreditError::NotEnoughCredit,
        );
        // Whatever the debtor comes to owe, the creditor may now owe it back before the debtor's
        // own limit is touched.
        give(&mut pair.room.at_mut(side(debtor, &low)), amount);
    }
}

#[contract(throws(CreditError, ERC20Error), emits(LineSet, Paid, PairClosed))]
impl MutualCredit {
    /// Start the network, asking `pair_bond` native tokens of whoever opens a pair. Callable once:
    /// call it in the transaction that deploys the contract. The contract must already hold the
    /// native tokens [`reserve_needed`] asks for.
    pub fn initialize(&mut self, pair_bond: i128) {
        ensure(
            self.config.try_get().none_if_missing().is_none(),
            CreditError::AlreadyInitialized,
        );
        ensure(pair_bond >= 0, CreditError::InvalidBond);
        ensure(
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&get_current_address())
                >= reserve_needed(pair_bond),
            CreditError::ReserveTooSmall,
        );
        // Exclusive, so two starts in one block cannot both commit.
        self.config.set_exclusive(&Config { pair_bond });
    }

    /// Let `debtor` owe the caller up to `limit`.
    ///
    /// The first limit between two members opens their pair, and takes the pair bond from the
    /// caller, in native tokens, on an allowance granted to this contract. A raise adds to the
    /// room from the next block. A cut takes from the room at once, so a limit cannot go below
    /// what the debtor owes -- nor below what payments in the same block take, which the runtime
    /// checks.
    pub fn set_limit(&mut self, debtor: ContractAddress, limit: i128) {
        let config = self.load();
        let creditor = get_caller();
        ensure(debtor != creditor, CreditError::SelfCredit);
        ensure((0..=MAX_LIMIT).contains(&limit), CreditError::InvalidLimit);

        let (low, high) = ordered(&creditor, &debtor);
        let mine = side(&creditor, &low);
        let mut row = self.pairs.at_mut(&low);
        let mut pair = row.at_mut(&high);

        match pair.terms.try_get().none_if_missing() {
            None => {
                ensure(limit > 0, CreditError::InvalidLimit);
                let mut limits = [0; 2];
                limits[mine as usize] = limit;
                // The exclusive write is what opens a pair once: two transactions that both found
                // it missing cannot both commit.
                pair.terms.set_exclusive(&PairTerms {
                    bonder: creditor,
                    bond: config.pair_bond,
                    limits,
                });
                pair.room.at_mut(mine).set_capacity(limit);
                // Created now, at zero, so that no payment ever has to create storage.
                pair.room.at_mut(1 - mine).set_capacity(0);
                if config.pair_bond > 0 {
                    ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
                        &creditor,
                        &get_current_address(),
                        config.pair_bond,
                    );
                }
            }
            Some(mut terms) => {
                let change = limit - terms.limits[mine as usize];
                if change > 0 {
                    give(&mut pair.room.at_mut(mine), change);
                } else if change < 0 {
                    take(
                        &mut pair.room.at_mut(mine),
                        -change,
                        CreditError::LimitBelowDebt,
                    );
                }
                terms.limits[mine as usize] = limit;
                // Exclusive: two changes to one pair in a block would each compute theirs from
                // the same old limits.
                pair.terms.set_exclusive(&terms);
            }
        }

        log_event(&LineSet {
            creditor,
            debtor,
            limit,
        });
    }

    /// Pay `to` from the caller, along `routes`. Returns the total paid.
    ///
    /// Along each route, the payer comes to owe the first member on it the route's amount more, that
    /// member the next, and so on to the payee. Each hop needs that much room on the line its
    /// creditor extends, or the payment is refused, whole. A member who owes the next one less
    /// needs no credit to pay: paying down a debt only gives the creditor room.
    ///
    /// A payment to oneself, round a cycle, changes nobody's position. Round a cycle of debts in
    /// the direction that pays them down, it cancels them.
    pub fn pay(&mut self, to: ContractAddress, routes: Routes) -> i128 {
        let from = get_caller();
        ensure(!routes.is_empty(), CreditError::InvalidRoute);

        let mut amount: i128 = 0;
        for route in routes.iter() {
            Self::check_route(&from, &to, route);
            amount = amount
                .checked_add(route.amount)
                .or_throw(CreditError::TooLarge);
            let mut debtor = from;
            for creditor in route.via.iter().chain([&to]) {
                self.hop(&debtor, creditor, route.amount);
                debtor = *creditor;
            }
        }

        log_event(&Paid {
            from,
            to,
            amount,
            routes,
        });
        amount
    }

    /// Close the pair of the caller and `other`, and pay its bond back to whoever opened it.
    ///
    /// Neither may extend credit to the other any more. Then neither can owe the other anything,
    /// since a limit cannot be cut below what is owed on it.
    pub fn close(&mut self, other: ContractAddress) {
        let (low, high) = ordered(&get_caller(), &other);
        let mut row = self.pairs.at_mut(&low);
        let mut pair = row.at_mut(&high);
        let terms = pair
            .terms
            .try_get()
            .none_if_missing()
            .or_throw(CreditError::NoSuchPair);
        ensure(terms.limits == [0, 0], CreditError::CreditExtended);

        // With both limits at zero, both rooms are zero too, so no payment in this block can take
        // from either: there is nothing for one to conflict with. The exclusive delete is what
        // makes a close happen once. Two closes in one block both read these terms, but cannot
        // both delete them; a limit set in the same block conflicts too.
        pair.delete_exclusive();
        if terms.bond > 0 {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(&terms.bonder, terms.bond);
        }

        log_event(&PairClosed {
            a: low,
            b: high,
            bonder: terms.bonder,
            bond: terms.bond,
        });
    }

    pub fn config(&self) -> Config {
        self.load()
    }

    /// The line `creditor` extends to `debtor`, as of this block's start. All zero if they have no
    /// pair.
    pub fn line(&self, creditor: ContractAddress, debtor: ContractAddress) -> Line {
        ensure(creditor != debtor, CreditError::SelfCredit);
        let (low, high) = ordered(&creditor, &debtor);
        let row = self.pairs.at(&low);
        let pair = row.at(&high);
        let Some(terms) = pair.terms.try_get().none_if_missing() else {
            return Line::default();
        };
        let mine = side(&creditor, &low);
        let limit = terms.limits[mine as usize];
        let room = pair.room.at(mine).get_remaining_capacity();
        Line {
            limit,
            owed: limit - room,
            room,
        }
    }
}
