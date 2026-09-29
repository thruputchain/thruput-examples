//! The exchange contract: batches keyed by block, offers aggregated into a commutative histogram,
//! and per-offer settlement.
//!
//! # Why nothing here is a queue
//!
//! SPEEDEX's central claim is that a batch exchange has no ordering inside a batch: every offer in a
//! batch trades at the same prices, so offers commute, and the price computation depends only on
//! the batch's *aggregate* supply and demand. This contract keeps that shape on chain:
//!
//! * [`submit_offer`](Speedex::submit_offer) escrows the seller's tokens and adds the amount to
//!   one cell of a histogram -- the batch's orderbook (sell asset, buy asset) at the offer's price
//!   level. The cell is an `NNInt`, whose increments merge, so any number of offers land in one
//!   block without contending. The offer itself is recorded under a fresh id.
//! * [`clear_batch`](Speedex::clear_batch) runs once per batch, after the batch's blocks have all
//!   closed. It reads the histogram -- a fixed number of cells, however many offers were made --
//!   computes prices, trims and haircuts with [`engine::clear`], and records them. Deterministic, so
//!   anyone may run it.
//! * [`settle_offer`](Speedex::settle_offer) pays out one offer from the recorded clearing and its
//!   own record alone. Settlements touch disjoint records and commutative balances, so a batch's
//!   offers settle in any order, any number to a block, alongside the next batch's submissions.
//!
//! The one thing that runs alone is the clearing transaction, and its cost does not grow with the
//! batch.
//!
//! # Simplifications relative to SPEEDEX
//!
//! * Limit prices sit on a geometric grid ([`engine::level_ratio`]), eight levels to the doubling,
//!   so an orderbook is a histogram rather than a sorted list. An offer's limit is rounded up to the
//!   next level.
//! * Offers are one-shot: what a batch does not fill is refunded at settlement, rather than resting
//!   in the orderbook for the next batch.
//! * Feasibility comes from per-asset trims and haircuts ([`engine::feasibility`]) instead of
//!   SPEEDEX's linear program. The exchange keeps a fee of one part in [`engine::FEE_DEN`] of every
//!   purchase, which is also what gives those levers their slack; the admin collects it.

use crate::engine::{self, Clearing, Haircuts, Price, Prices, Trims};
use groundhog_erc20_if::{ERC20Client, ERC20Error};
use sdk::storage::*;
use sdk::*;
use unique_ids::UniqueIds;

pub use crate::engine::MAX_ASSETS;

/// A contract address.
pub type Address = ContractAddress;
/// The exchange's assets, in index order; entries at or past `n_assets` are zero.
pub type Assets = [Address; MAX_ASSETS];
/// The id stamped on an accepted offer.
pub type OfferId = SHA256Hash;
/// Which batch an offer belongs to: its block height divided by the epoch length.
pub type BatchId = u64;

/// The most offers of one asset a batch may hold at one level: the histogram cell is an `i128`, and
/// `2^80` offers of `2^47` fit.
pub const MAX_OFFERS_PER_CELL: u128 = 1 << 47;

#[contract_exception]
pub enum SpeedexError {
    AlreadyInitialized = 1,
    /// Fewer than two assets, more than [`MAX_ASSETS`], a repeated or zero asset, a zero epoch, or
    /// a grid wider than [`engine::MAX_OCTAVES`].
    InvalidConfiguration = 2,
    /// An asset index out of range, or a sell asset equal to the buy asset.
    InvalidAsset = 3,
    /// A zero amount, or one at or above [`engine::MAX_AMOUNT`].
    InvalidAmount = 4,
    /// A zero limit, or one above the top of the grid.
    InvalidPrice = 5,
    /// `clear_batch` was asked for a batch whose epoch has not ended.
    BatchOpen = 6,
    /// `clear_batch` was asked for a batch with no offers.
    BatchEmpty = 7,
    /// `clear_batch` was asked for a batch that already has a clearing.
    AlreadyCleared = 8,
    /// `settle_offer` was asked for an offer whose batch has no clearing yet.
    NotCleared = 9,
    /// No offer with that id is waiting.
    NoSuchOffer = 10,
    /// `cancel_offer` by someone other than the owner, or `collect_fees` by someone other than the
    /// admin.
    Unauthorized = 11,
    /// `cancel_offer` on an offer whose batch has closed; settle it instead.
    BatchClosed = 12,
}

/// How the exchange was set up.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// Who may collect the exchange's fees.
    pub admin: Address,
    pub n_assets: u32,
    pub assets: Assets,
    /// Blocks per batch.
    pub epoch_len: u64,
    /// Half-width of the limit-price grid, in doublings; see [`engine::levels`].
    pub octaves: u32,
}

/// An offer awaiting settlement.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Offer {
    pub owner: Address,
    pub batch: BatchId,
    pub sell: u32,
    pub buy: u32,
    /// The grid level the limit was rounded up to.
    pub level: u32,
    pub amount: u128,
}

#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct OfferAccepted<'a> {
    #[topic]
    pub owner: &'a Address,
    #[topic]
    pub offer_id: &'a OfferId,
    pub batch: BatchId,
    pub sell: u32,
    pub buy: u32,
    pub amount: u128,
    /// The limit as rounded up to the grid.
    pub limit: Price,
}

#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct OfferCancelled<'a> {
    #[topic]
    pub owner: &'a Address,
    #[topic]
    pub offer_id: &'a OfferId,
}

#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct BatchCleared {
    #[topic]
    pub batch: BatchId,
    pub prices: Prices,
    pub trims: Trims,
    pub haircuts: Haircuts,
    pub rounds: u32,
    pub volume: u128,
    pub surplus: [u128; MAX_ASSETS],
}

#[derive(Event, Clone, Debug, PartialEq, Eq)]
pub struct OfferSettled<'a> {
    #[topic]
    pub owner: &'a Address,
    #[topic]
    pub offer_id: &'a OfferId,
    pub sold: u128,
    pub bought: u128,
    pub refunded: u128,
}

/// State for the exchange.
#[storage]
pub struct Speedex {
    config: Value<Config>,

    // The histogram: batch -> (orderbook, level) -> amount offered. Increments merge, so offers in
    // one block never contend. Cells are deleted as their batch is cleared.
    books: Map<BatchId, Map<u32, NNInt>>,

    // What clearing each batch decided. Written once, by whoever clears the batch first.
    clearings: Map<BatchId, Value<Clearing>>,

    // Offers awaiting settlement, each under its own key.
    offers: Map<OfferId, Value<Offer>>,
    ids: Node<UniqueIds>,

    // Fees the admin may collect, per asset: credited by each clearing with the surplus the engine
    // guarantees, debited by `collect_fees`. Increments and decrements merge.
    fees: Map<u32, NNInt>,
}

// Where an orderbook level lives in a batch's histogram.
#[inline(never)]
fn cell(sell: u32, buy: u32, level: u32) -> u32 {
    (sell * MAX_ASSETS as u32 + buy) * engine::MAX_LEVELS + level
}

impl Speedex {
    #[inline(never)]
    fn cfg(&self) -> Config {
        self.config.get()
    }

    #[inline(never)]
    fn batch_of_height(cfg: &Config) -> BatchId {
        let height = get_block_height().into_inner().max(0) as u64;
        height / cfg.epoch_len
    }

    #[inline(never)]
    fn token(cfg: &Config, index: u32) -> ERC20Client {
        ERC20Client::new(&cfg.assets[index as usize])
    }

    #[inline(never)]
    fn fees_of(&self, asset: u32) -> u128 {
        self.fees
            .at(&asset)
            .try_get()
            .none_if_missing()
            .unwrap_or(0)
            .max(0) as u128
    }

    #[inline(never)]
    fn offer_at(&self, id: &OfferId) -> Offer {
        self.offers
            .at(id)
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(SpeedexError::NoSuchOffer))
    }
}

#[contract(
    throws(SpeedexError, ERC20Error),
    emits(OfferAccepted, OfferCancelled, BatchCleared, OfferSettled)
)]
impl Speedex {
    /// Set up the exchange over `assets[..n_assets]`, batching every `epoch_len` blocks, with limit
    /// prices on a grid of `octaves` doublings either side of one. `admin` collects the fees. Call
    /// once.
    pub fn initialize(
        &mut self,
        admin: &Address,
        n_assets: u32,
        assets: Assets,
        epoch_len: u64,
        octaves: u32,
    ) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(SpeedexError::AlreadyInitialized);
        }
        let n = n_assets as usize;
        ensure(
            (2..=MAX_ASSETS).contains(&n)
                && epoch_len > 0
                && (1..=engine::MAX_OCTAVES).contains(&octaves),
            SpeedexError::InvalidConfiguration,
        );
        let zero = Address::new([0; 32]);
        for i in 0..n {
            ensure(assets[i] != zero, SpeedexError::InvalidConfiguration);
            for j in 0..i {
                ensure(assets[i] != assets[j], SpeedexError::InvalidConfiguration);
            }
        }
        let mut assets = assets;
        assets[n..].fill(zero);

        self.config.set_exclusive(&Config {
            admin: *admin,
            n_assets,
            assets,
            epoch_len,
            octaves,
        });
    }

    /// Offer `amount` of asset `sell` for asset `buy`, at no less than `min_price` units of `buy`
    /// per unit of `sell` (Q32; [`engine::PRICE_ONE`] is one). The limit is rounded up to the grid.
    ///
    /// Takes the `amount` from the caller's allowance to this contract, into escrow, and joins the
    /// batch of the current block. Returns the id to settle or cancel by.
    ///
    /// Commutes with every other submission, cancellation and settlement: it writes a fresh offer
    /// record, increments a histogram cell and an id counter, and moves tokens.
    pub fn submit_offer(&mut self, sell: u32, buy: u32, amount: u128, min_price: Price) -> OfferId {
        let cfg = self.cfg();
        ensure(
            sell < cfg.n_assets && buy < cfg.n_assets && sell != buy,
            SpeedexError::InvalidAsset,
        );
        ensure(
            amount > 0 && amount < engine::MAX_AMOUNT,
            SpeedexError::InvalidAmount,
        );
        ensure(min_price > 0, SpeedexError::InvalidPrice);
        let level = engine::level_for(min_price, cfg.octaves)
            .unwrap_or_else(|| throw(SpeedexError::InvalidPrice));

        let owner = get_caller();
        Self::token(&cfg, sell).transfer_from(&owner, &get_current_address(), amount);

        let batch = Self::batch_of_height(&cfg);
        self.books
            .at_mut(&batch)
            .at_mut(&cell(sell, buy, level))
            .inc(amount as i128);

        // The id names the submission (a per-transaction unique id) and commits to what was
        // submitted, so ids of distinct offers stay distinct even where transaction hashes do not.
        let offer = Offer {
            owner,
            batch,
            sell,
            buy,
            level,
            amount,
        };
        let id = (self.ids.next_id(), offer).hash();
        self.offers.at_mut(&id).set(&offer);

        log_event(&OfferAccepted {
            owner: &owner,
            offer_id: &id,
            batch,
            sell,
            buy,
            amount,
            limit: engine::level_ratio(level, cfg.octaves),
        });

        id
    }

    /// Withdraw an offer whose batch is still open, refunding its escrow. Owner only.
    pub fn cancel_offer(&mut self, id: &OfferId) {
        let cfg = self.cfg();
        let offer = self.offer_at(id);
        ensure(get_caller() == offer.owner, SpeedexError::Unauthorized);
        ensure(
            offer.batch == Self::batch_of_height(&cfg),
            SpeedexError::BatchClosed,
        );

        self.books
            .at_mut(&offer.batch)
            .at_mut(&cell(offer.sell, offer.buy, offer.level))
            .inc(-(offer.amount as i128));
        self.offers.delete_at(id);
        Self::token(&cfg, offer.sell).transfer(&offer.owner, offer.amount);

        log_event(&OfferCancelled {
            owner: &offer.owner,
            offer_id: id,
        });
    }

    /// Compute and record the clearing of a closed batch. Anyone may call this, once per batch;
    /// the result is a pure function of the batch's histogram.
    ///
    /// Reads `n * (n - 1) * levels` histogram cells whatever the number of offers, and deletes the
    /// ones it found occupied.
    pub fn clear_batch(&mut self, batch: BatchId) -> Clearing {
        let cfg = self.cfg();
        ensure(batch < Self::batch_of_height(&cfg), SpeedexError::BatchOpen);
        ensure(
            self.clearings
                .at(&batch)
                .try_get()
                .none_if_missing()
                .is_none(),
            SpeedexError::AlreadyCleared,
        );

        let n = cfg.n_assets as usize;
        let book = self.books.at(&batch);
        let buckets = engine::buckets(n, cfg.octaves, |sell, buy, level| {
            book.at(&cell(sell as u32, buy as u32, level))
                .try_get()
                .none_if_missing()
                .unwrap_or(0)
                .max(0) as u128
        });
        drop(book);
        ensure(!buckets.is_empty(), SpeedexError::BatchEmpty);

        let clearing = engine::clear(&buckets, n);

        // The histogram has served its purpose; only the clearing is needed from here on.
        let mut book = self.books.at_mut(&batch);
        for b in &buckets {
            let level = engine::level_for(b.limit, cfg.octaves).unwrap();
            book.delete_at(&cell(b.sell as u32, b.buy as u32, level));
        }
        drop(book);

        self.clearings.at_mut(&batch).set_exclusive(&clearing);

        // The fee is the exchange's as soon as the batch clears: every offer's escrow is already
        // here, and settlement pays out strictly less than what stays.
        for a in 0..n {
            if clearing.surplus[a] > 0 {
                self.fees
                    .at_mut(&(a as u32))
                    .inc(clearing.surplus[a] as i128);
            }
        }

        log_event(&BatchCleared {
            batch,
            prices: clearing.prices,
            trims: clearing.trims,
            haircuts: clearing.haircuts,
            rounds: clearing.rounds,
            volume: clearing.volume,
            surplus: clearing.surplus,
        });

        clearing
    }

    /// Pay out one offer of a cleared batch: what it bought, and a refund of what it did not sell.
    /// Anyone may call this; the proceeds go to the offer's owner.
    ///
    /// Commutes with every other settlement and submission.
    pub fn settle_offer(&mut self, id: &OfferId) {
        let cfg = self.cfg();
        let offer = self.offer_at(id);
        let clearing = self
            .clearings
            .at(&offer.batch)
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(SpeedexError::NotCleared));

        let fill = engine::fill(
            offer.amount,
            offer.sell as usize,
            offer.buy as usize,
            engine::level_ratio(offer.level, cfg.octaves),
            &clearing,
        );
        let refunded = offer.amount - fill.sold;

        self.offers.delete_at(id);
        if fill.bought > 0 {
            Self::token(&cfg, offer.buy).transfer(&offer.owner, fill.bought);
        }
        if refunded > 0 {
            Self::token(&cfg, offer.sell).transfer(&offer.owner, refunded);
        }

        log_event(&OfferSettled {
            owner: &offer.owner,
            offer_id: id,
            sold: fill.sold,
            bought: fill.bought,
            refunded,
        });
    }

    /// Send the fees collected so far in `asset` to the admin, and return the amount. Admin only.
    pub fn collect_fees(&mut self, asset: u32) -> u128 {
        let cfg = self.cfg();
        ensure(get_caller() == cfg.admin, SpeedexError::Unauthorized);
        ensure(asset < cfg.n_assets, SpeedexError::InvalidAsset);

        let amount = self.fees_of(asset);
        if amount > 0 {
            self.fees.at_mut(&asset).inc(-(amount as i128));
            Self::token(&cfg, asset).transfer(&cfg.admin, amount);
        }
        amount
    }

    pub fn config(&self) -> Config {
        self.cfg()
    }

    /// The fees collectable in `asset`.
    pub fn fees(&self, asset: u32) -> u128 {
        self.fees_of(asset)
    }

    /// The batch an offer submitted now would join.
    pub fn current_batch(&self) -> BatchId {
        Self::batch_of_height(&self.cfg())
    }

    /// A batch's clearing, if it has one.
    pub fn clearing(&self, batch: BatchId) -> Option<Clearing> {
        self.clearings.at(&batch).try_get().none_if_missing()
    }

    /// An offer awaiting settlement, if there is one under this id.
    pub fn offer(&self, id: &OfferId) -> Option<Offer> {
        self.offers.at(id).try_get().none_if_missing()
    }

    /// The grid level a limit of `min_price` would be rounded up to.
    pub fn level_for(&self, min_price: Price) -> u32 {
        engine::level_for(min_price, self.cfg().octaves)
            .unwrap_or_else(|| throw(SpeedexError::InvalidPrice))
    }

    /// The limit ratio (Q32) of a grid level.
    pub fn level_ratio(&self, level: u32) -> Price {
        engine::level_ratio(level, self.cfg().octaves)
    }
}
