use crate::bucket::{Bucket, Limit};
use thruput_erc20_if::ERC20Client;
use thruput_sdk::storage::deletable::Deletable;
use thruput_sdk::storage::{Map, Node, Value};
use thruput_sdk::*;

#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// Who grants and revokes spenders, changes the limits, and withdraws.
    pub owner: ContractAddress,

    /// The token the budget holds and pays out. The native token works like any other.
    pub token: ContractAddress,

    /// The limit on every spender together.
    pub limit: Limit,
}

/// What one spender may do.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    /// The spender's own limit, within the shared one.
    pub limit: Limit,

    /// The only address the spender may pay, if any. A spender that pays one provider, say, can
    /// then send nothing anywhere else, even if its key is stolen.
    pub payee: Option<ContractAddress>,
}

#[contract_exception]
pub enum BudgetError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NotOwner = 3,
    /// A negative burst or refill, or a period of zero.
    InvalidLimit = 4,
    /// The token is this contract, or the zero address.
    InvalidToken = 5,
    /// The caller has no grant.
    NotASpender = 6,
    /// The spender may only pay its payee.
    WrongPayee = 7,
    /// An amount that is not positive.
    InvalidAmount = 8,
    /// More than the spender's own bucket holds in this block.
    OverSpenderLimit = 9,
    /// More than the shared bucket holds in this block.
    OverSharedLimit = 10,
    /// The spender still has a grant: revoke it first.
    StillGranted = 11,
}

#[derive(Event, Clone, Debug)]
pub struct Spent {
    #[topic]
    pub spender: ContractAddress,
    #[topic]
    pub to: ContractAddress,
    pub amount: i128,
}

#[derive(Event, Clone, Debug)]
pub struct Granted {
    #[topic]
    pub spender: ContractAddress,
    pub grant: Grant,
}

#[derive(Event, Clone, Debug)]
pub struct Revoked {
    #[topic]
    pub spender: ContractAddress,
}

/// A shared budget that many spenders draw on at once.
///
/// The owner funds the budget with a token and grants spenders -- services, bots, agents, the
/// session keys of a game -- each its own [`Limit`]: a bucket that holds up to a burst and refills
/// at a steady rate. A further limit, shared, bounds what every spender together can pay out. A
/// spend takes its amount from both buckets, and pays it.
///
/// Spends never wait for each other. Any number of them, from different spenders or from one
/// spender at once, land in the same block, and the runtime admits them while they fit both
/// buckets: each bucket's contents are a `CapacityConstraint`, a sum the runtime checks across a
/// block's transactions, not a number each spend reads and rewrites. Spends that do not fit are
/// turned away, and nothing they did is kept.
///
/// Spends never wait for the owner either, or hold the owner up: the owner's changes write only
/// what spends read, never what they write. In particular, no spender can hold off its own
/// revocation by keeping its key busy.
#[thruput_sdk::storage]
pub struct Budget {
    config: Value<Config>,

    // The bucket every spend takes from, whoever the spender.
    shared: Node<Bucket>,

    // What each spender may do. Spends read a grant, and only the owner writes one.
    grants: Map<ContractAddress, Value<Grant>>,

    // Each spender's bucket: written by its spends, and by the owner only when it has no grant,
    // so that no spend can be writing it too.
    buckets: Map<ContractAddress, Node<Bucket>>,
}

impl Budget {
    fn load(&self) -> Config {
        self.config
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(BudgetError::NotInitialized))
    }

    fn load_as_owner(&self) -> Config {
        let config = self.load();
        ensure(get_caller() == config.owner, BudgetError::NotOwner);
        config
    }

    fn find_grant(&self, spender: &ContractAddress) -> Option<Grant> {
        self.grants.at(spender).try_get().none_if_missing()
    }
}

#[contract(
    throws(BudgetError, thruput_erc20_if::ERC20Error),
    emits(Spent, Granted, Revoked)
)]
impl Budget {
    /// Start the budget: the caller owns it, it pays out `token`, and every spender together can
    /// pay out no more than `limit` allows. The shared bucket starts full. Call it in the
    /// transaction that deploys the contract, so nobody else can start it first.
    ///
    /// The budget's own storage, and each grant's, is paid for out of the native tokens it holds:
    /// send it some when you deploy it.
    pub fn initialize(&mut self, token: &ContractAddress, limit: Limit) {
        ensure(
            self.config.try_get().none_if_missing().is_none(),
            BudgetError::AlreadyInitialized,
        );
        ensure(limit.is_valid(), BudgetError::InvalidLimit);
        ensure(
            *token != get_current_address() && *token != ContractAddress::default(),
            BudgetError::InvalidToken,
        );

        self.config.set_exclusive(&Config {
            owner: get_caller(),
            token: *token,
            limit,
        });
        self.shared.fill(limit.burst);
    }

    /// Let `spender` spend under `limit`, and only to `payee` if one is named. Only the owner.
    ///
    /// A new spender's bucket starts full. For a spender that already has a grant, this replaces
    /// it, and leaves its bucket alone: the bucket keeps what it holds, up to the new burst, and
    /// the new limit applies from its next refill. So changing a busy spender's limit does not
    /// conflict with its spends; those in this same block still go by the old grant.
    pub fn grant(
        &mut self,
        spender: &ContractAddress,
        limit: Limit,
        payee: Option<ContractAddress>,
    ) {
        self.load_as_owner();
        ensure(limit.is_valid(), BudgetError::InvalidLimit);

        if self.find_grant(spender).is_none() {
            // Nobody can spend from this bucket in this block, since no spend in it finds a grant
            // as of the block's start: the owner can write it without conflicting with one.
            self.buckets.at_mut(spender).fill(limit.burst);
        }

        let grant = Grant { limit, payee };
        self.grants.at_mut(spender).set(&grant);
        log_event(&Granted {
            spender: *spender,
            grant,
        });
    }

    /// Stop `spender` spending. Only the owner.
    ///
    /// This deletes the grant, which spends only read, and nothing that spends write: it never
    /// conflicts with them, so a spender cannot hold it off by keeping its key busy. The price is
    /// that the spender's spends in this same block, which find the grant as of the block's start,
    /// still count. They cannot take more than its bucket held.
    pub fn revoke(&mut self, spender: &ContractAddress) {
        self.load_as_owner();
        ensure(self.find_grant(spender).is_some(), BudgetError::NotASpender);
        self.grants.at_mut(spender).delete();
        log_event(&Revoked { spender: *spender });
    }

    /// Delete a revoked spender's bucket, returning its storage deposit to the budget. Only the
    /// owner.
    ///
    /// Call it in a later block than the revoke. In the revoke's own block, the spender's last
    /// spends may still be writing the bucket, and deleting it would conflict with them.
    pub fn forget(&mut self, spender: &ContractAddress) {
        self.load_as_owner();
        ensure(
            self.find_grant(spender).is_none(),
            BudgetError::StillGranted,
        );
        self.buckets.at_mut(spender).delete();
    }

    /// Change the limit on every spender together. Only the owner.
    ///
    /// The shared bucket keeps what it holds, up to the new burst, and the new limit applies from
    /// its next refill. Spends in this same block still go by the old limit.
    pub fn set_limit(&mut self, limit: Limit) {
        let config = self.load_as_owner();
        ensure(limit.is_valid(), BudgetError::InvalidLimit);
        self.config.set(&Config { limit, ..config });
    }

    /// Pay `amount` of the budget's token to `to`, taking it from the caller's bucket and the
    /// shared one.
    ///
    /// The amount must fit both buckets as of this block's start. Spends in the same block do not
    /// see each other: together, they are admitted while they fit both, and the runtime turns
    /// away the rest.
    pub fn spend(&mut self, to: &ContractAddress, amount: i128) {
        let config = self.load();
        ensure(amount > 0, BudgetError::InvalidAmount);
        let spender = get_caller();
        let grant = self
            .find_grant(&spender)
            .unwrap_or_else(|| throw(BudgetError::NotASpender));
        if let Some(payee) = grant.payee {
            ensure(*to == payee, BudgetError::WrongPayee);
        }

        ensure(
            self.buckets.at_mut(&spender).take(&grant.limit, amount),
            BudgetError::OverSpenderLimit,
        );
        ensure(
            self.shared.take(&config.limit, amount),
            BudgetError::OverSharedLimit,
        );
        ERC20Client::new(&config.token).transfer(to, amount);

        log_event(&Spent {
            spender,
            to: *to,
            amount,
        });
    }

    /// Pay `amount` to `to`, outside every limit. Only the owner.
    pub fn withdraw(&mut self, to: &ContractAddress, amount: i128) {
        let config = self.load_as_owner();
        ensure(amount > 0, BudgetError::InvalidAmount);
        ERC20Client::new(&config.token).transfer(to, amount);
    }

    pub fn config(&self) -> Config {
        self.load()
    }

    pub fn grant_of(&self, spender: &ContractAddress) -> Option<Grant> {
        self.find_grant(spender)
    }

    /// What `spender` could spend in this block: the less of what its bucket and the shared one
    /// hold. Zero for an address with no grant. Spends by others in this block are not counted.
    pub fn available(&self, spender: &ContractAddress) -> i128 {
        let Some(grant) = self.find_grant(spender) else {
            return 0;
        };
        let own = self.buckets.at(spender).available(&grant.limit);
        own.min(self.shared_available())
    }

    /// What every spender together could spend in this block.
    pub fn shared_available(&self) -> i128 {
        self.shared.available(&self.load().limit)
    }
}
