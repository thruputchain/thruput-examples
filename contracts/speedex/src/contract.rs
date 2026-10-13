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
//!   closed. It reads the histogram's occupied cells -- one per price level in use --
//!   computes prices and each orderbook's trades with [`engine::clear`], and records them.
//!   Deterministic, so anyone may run it.
//! * [`settle_offer`](Speedex::settle_offer) pays out one offer from the recorded clearing and its
//!   own record alone. Settlements touch disjoint records and commutative balances, so a batch's
//!   offers settle in any order, any number to a block, alongside the next batch's submissions.
//!
//! The one thing that runs alone is the clearing transaction, and its cost grows with the number
//! of distinct limit prices in the batch, never with the number of offers.
//!
//! # Simplifications relative to SPEEDEX
//!
//! * Limit prices sit on a geometric grid ([`engine::Grid`]) of up to `2^16` levels to the
//!   doubling, so an orderbook is a histogram rather than a sorted list. An offer's limit is rounded
//!   up to the next level.
//! * A grid that fine cannot be read whole, so the clearer names the occupied cells and the
//!   contract checks the list against a per-orderbook total that every submission also updates:
//!   a list that does not account for everything offered is refused, so the clearing remains a
//!   pure function of the batch.
//! * Offers are one-shot: what a batch does not fill is refunded at settlement, rather than resting
//!   in the orderbook for the next batch.
//! * There is no fee. The linear program that decides what each orderbook trades is, without one,
//!   a maximum circulation on the graph of assets, and is solved as such in exact integers
//!   ([`engine::clear`]); what rounding leaves behind stays with the exchange as dust.

use crate::engine::{self, BookFill, Clearing, Grid, Price, Prices};
use alloc::vec::Vec;
use sdk::storage::*;
use sdk::*;
use thruput_erc20_if::{ERC20Client, ERC20Error};
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

/// The guest's data memory, in bytes: what the artifact declares (`initial_memory_bytes` in
/// `Cargo.toml`, the protocol's 64 KiB unless stated), read from the linker's end-of-memory
/// symbol so that a build with more memory clears larger batches without any other change.
/// Natively there is no guest, and the protocol default stands in.
pub fn guest_memory() -> usize {
    #[cfg(target_arch = "riscv32")]
    {
        unsafe extern "C" {
            static __heap_end: u8;
        }
        (&raw const __heap_end) as usize
    }
    #[cfg(not(target_arch = "riscv32"))]
    {
        64 * 1024
    }
}

/// The most occupied histogram cells -- price levels in use, over all orderbooks -- one clearing
/// of an exchange with `n_assets` assets reads: [`max_clear_cells_in`] the guest's memory. A
/// batch with more cannot be cleared, so this is a liveness bound to set against the grid's
/// fineness and the epoch's length.
pub fn max_clear_cells(n_assets: usize) -> usize {
    max_clear_cells_in(guest_memory(), n_assets)
}

/// [`max_clear_cells`] for a guest with `memory` bytes.
///
/// The bound is memory: the guest's allocator never frees, so everything a clearing allocates
/// has to fit at once. Measured on the RV32 executor (`tests/test_rv32.rs`), 43.7 KiB of the
/// guest's memory is spoken for before an entry point runs (a 30 KiB stack reserve, the
/// runtime's and the SDK's own), and a clearing then takes some 5 KiB, 32 bytes per bucket and
/// about 240 bytes per orderbook (its edge of the value graph in `U256`, its fill, and its two
/// columns of the simplex tableau); this keeps a tenth of the rest in hand. With the protocol's
/// 64 KiB that is 130 cells for eight assets and 300 for three; with 256 KiB, about 5,600 and
/// 6,100. What a node charges is the other bound on a batch: about 37.5k gas per cell read (a
/// cold database load) (`tests/testkit_gas.rs`).
pub const fn max_clear_cells_in(memory: usize, n_assets: usize) -> usize {
    let books = n_assets * (n_assets - 1);
    let free = memory - 44 * 1024 - 5 * 1024 - 240 * books;
    free / 32 * 9 / 10
}

#[contract_exception]
pub enum SpeedexError {
    AlreadyInitialized = 1,
    /// Fewer than two assets, more than [`MAX_ASSETS`], a repeated or zero asset, a zero epoch, or
    /// a grid outside what [`engine::Grid::is_valid`] allows.
    InvalidConfiguration = 2,
    /// An asset index out of range, or a sell asset equal to the buy asset.
    InvalidAsset = 3,
    /// An amount below [`engine::MIN_AMOUNT`] or at or above [`engine::MAX_AMOUNT`].
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
    /// `cancel_offer` by someone other than the owner.
    Unauthorized = 11,
    /// `cancel_offer` on an offer whose batch has closed; settle it instead.
    BatchClosed = 12,
    /// `clear_batch` was given a malformed cell list: not whole cells, not strictly increasing,
    /// more than [`max_clear_cells`] allows, or a cell outside the exchange's books and levels.
    InvalidCells = 13,
    /// `clear_batch` was given a cell list that does not account for everything offered in the
    /// batch: some orderbook's listed cells do not sum to its total.
    BatchMismatch = 14,
}

/// How the exchange was set up.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub n_assets: u32,
    pub assets: Assets,
    /// Blocks per batch.
    pub epoch_len: u64,
    /// Half-width of the limit-price grid, in doublings; see [`engine::Grid`].
    pub octaves: u32,
    /// Fineness of the grid: `2^level_bits` levels to the doubling.
    pub level_bits: u32,
    /// The most tâtonnement rounds a clearing runs; see [`engine::MAX_ROUNDS`].
    pub rounds: u32,
}

/// What the parts of a clearing cost, measured on the node that ran
/// [`measure_clearing`](Speedex::measure_clearing).
#[contract_type]
#[derive(Clone, Copy)]
pub struct GasReport {
    /// Occupied cells read.
    pub cells: u32,
    /// Gas spent checking and reading the cell list.
    pub read: u64,
    /// Gas spent finding prices (tâtonnement).
    pub prices: u64,
    /// Gas spent on the circulation and the book fills.
    pub circulation: u64,
    /// The clearing those prices give.
    pub clearing: Clearing,
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
    pub rounds: u32,
    pub pivots: u32,
    pub volume: u128,
    pub shortfall: u128,
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

    // What each orderbook was offered in total, per batch: the check that a clearing's cell list
    // is complete.
    totals: Map<BatchId, Map<u32, NNInt>>,

    // What clearing each batch decided: the prices, and per orderbook (see `engine::book`) what it
    // traded. Written once, by whoever clears the batch first; a book with no entry traded nothing.
    clearings: Map<BatchId, Value<Clearing>>,
    fills: Map<BatchId, Map<u32, Value<BookFill>>>,

    // Offers awaiting settlement, each under its own key.
    offers: Map<OfferId, Value<Offer>>,
    ids: Node<UniqueIds>,
}

// Where an orderbook level lives in a batch's histogram: the book index (see `engine::book`) above
// the level's 20 bits. Cells therefore sort by book, then level.
const LEVEL_BITS: u32 = 20;

#[inline(never)]
fn cell(book: u32, level: u32) -> u32 {
    (book << LEVEL_BITS) | level
}

impl Speedex {
    #[inline(never)]
    fn cfg(&self) -> Config {
        self.config.get()
    }

    fn grid(cfg: &Config) -> Grid {
        Grid {
            octaves: cfg.octaves,
            level_bits: cfg.level_bits,
        }
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
    /// prices on a grid of `octaves` doublings either side of one, `2^level_bits` levels to the
    /// doubling. Call once.
    pub fn initialize(
        &mut self,
        n_assets: u32,
        assets: Assets,
        epoch_len: u64,
        octaves: u32,
        level_bits: u32,
        rounds: u32,
    ) {
        if self.config.try_get().none_if_missing().is_some() {
            throw(SpeedexError::AlreadyInitialized);
        }
        let n = n_assets as usize;
        let grid = Grid {
            octaves,
            level_bits,
        };
        ensure(
            (2..=MAX_ASSETS).contains(&n)
                && epoch_len > 0
                && grid.is_valid()
                && (1..=engine::MAX_ROUNDS).contains(&rounds),
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
            n_assets,
            assets,
            epoch_len,
            octaves,
            level_bits,
            rounds,
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
            (engine::MIN_AMOUNT..engine::MAX_AMOUNT).contains(&amount),
            SpeedexError::InvalidAmount,
        );
        ensure(min_price > 0, SpeedexError::InvalidPrice);
        let grid = Self::grid(&cfg);
        let level = grid
            .level_for(min_price)
            .unwrap_or_else(|| throw(SpeedexError::InvalidPrice));

        let owner = get_caller();
        Self::token(&cfg, sell).transfer_from(&owner, &get_current_address(), amount as i128);

        let batch = Self::batch_of_height(&cfg);
        let book = engine::book(sell as usize, buy as usize) as u32;
        self.books
            .at_mut(&batch)
            .at_mut(&cell(book, level))
            .inc(amount as i128);
        self.totals.at_mut(&batch).at_mut(&book).inc(amount as i128);

        // The id names the submission (a per-transaction unique id) and commits to what was
        // submitted, so ids of distinct offers stay distinct even where transaction hashes do not.
        // The record is written under an exclusive lock so that even two *identical* submissions
        // with one id (possible only where transaction hashes coincide) cannot both land: the loser
        // is returned to the mempool rather than escrowed under a record it shares.
        let offer = Offer {
            owner,
            batch,
            sell,
            buy,
            level,
            amount,
        };
        let id = (self.ids.next_id(), offer).hash();
        self.offers.at_mut(&id).set_exclusive(&offer);

        log_event(&OfferAccepted {
            owner: &owner,
            offer_id: &id,
            batch,
            sell,
            buy,
            amount,
            limit: grid.ratio(level),
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

        let book = engine::book(offer.sell as usize, offer.buy as usize) as u32;
        self.books
            .at_mut(&offer.batch)
            .at_mut(&cell(book, offer.level))
            .inc(-(offer.amount as i128));
        self.totals
            .at_mut(&offer.batch)
            .at_mut(&book)
            .inc(-(offer.amount as i128));
        self.offers.delete_at(id);
        Self::token(&cfg, offer.sell).transfer(&offer.owner, offer.amount as i128);

        log_event(&OfferCancelled {
            owner: &offer.owner,
            offer_id: id,
        });
    }

    /// Compute and record the clearing of a closed batch. Anyone may call this, once per batch;
    /// the result is a pure function of the batch's histogram.
    ///
    /// `cells` names the histogram cells in use -- each a `u32` as [`cell`] packs it, little-endian,
    /// concatenated, strictly increasing -- which any indexer knows from the batch's
    /// [`OfferAccepted`] events. The contract reads exactly those, at most [`max_clear_cells`], and
    /// refuses the list unless every orderbook's listed cells sum to what it was offered in total:
    /// an incomplete list is [`SpeedexError::BatchMismatch`], never a clearing.
    pub fn clear_batch(&mut self, batch: BatchId, cells: &[u8]) -> Clearing {
        let cfg = self.cfg();
        let (buckets, listed) = self.read_batch(&cfg, batch, cells);
        let n = cfg.n_assets as usize;
        let (clearing, fills) = engine::clear(&buckets, n, cfg.rounds);

        // The histogram has served its purpose; only the clearing is needed from here on.
        let mut book = self.books.at_mut(&batch);
        for b in &buckets {
            book.delete_at(&cell(
                engine::book(b.sell as usize, b.buy as usize) as u32,
                b.level,
            ));
        }
        drop(book);
        let mut totals = self.totals.at_mut(&batch);
        for (index, total) in listed.iter().enumerate() {
            if *total > 0 {
                totals.delete_at(&(index as u32));
            }
        }
        drop(totals);

        self.clearings.at_mut(&batch).set_exclusive(&clearing);
        let mut traded = self.fills.at_mut(&batch);
        for (index, fill) in &fills {
            traded.at_mut(&(*index as u32)).set_exclusive(fill);
        }
        drop(traded);

        log_event(&BatchCleared {
            batch,
            prices: clearing.prices,
            rounds: clearing.rounds,
            pivots: clearing.pivots,
            volume: clearing.volume,
            shortfall: clearing.shortfall,
        });

        clearing
    }

    /// Run a closed batch's clearing without recording it, and report what each part of it cost
    /// in gas, with tâtonnement capped at `rounds` in place of the configured cap. The batch stays
    /// clearable: this is how a clearer learns what [`clear_batch`](Self::clear_batch) will cost
    /// before paying it, and how `tests/testkit_gas.rs` measures the engine.
    pub fn measure_clearing(&mut self, batch: BatchId, cells: &[u8], rounds: u32) -> GasReport {
        use sdk::stats::gas_remaining;
        let start = gas_remaining();
        let cfg = self.cfg();
        let (buckets, _) = self.read_batch(&cfg, batch, cells);
        let read = gas_remaining();
        let n = cfg.n_assets as usize;
        let (prices, rounds) = engine::tatonnement(&buckets, n, rounds);
        let priced = gas_remaining();
        let (clearing, _) = engine::trades(&buckets, n, &prices, rounds);
        let circulated = gas_remaining();
        GasReport {
            cells: buckets.len() as u32,
            read: start.saturating_sub(read),
            prices: read.saturating_sub(priced),
            circulation: priced.saturating_sub(circulated),
            clearing,
        }
    }

    // A closed, uncleared batch's listed cells as buckets, in list order, with each orderbook's
    // listed total; every check of `clear_batch` is here. Not inlined: two entry points share it.
    #[inline(never)]
    fn read_batch(
        &self,
        cfg: &Config,
        batch: BatchId,
        cells: &[u8],
    ) -> (Vec<engine::Bucket>, [u128; engine::MAX_BOOKS]) {
        ensure(batch < Self::batch_of_height(cfg), SpeedexError::BatchOpen);
        ensure(
            self.clearings
                .at(&batch)
                .try_get()
                .none_if_missing()
                .is_none(),
            SpeedexError::AlreadyCleared,
        );

        let n = cfg.n_assets as usize;
        let grid = Self::grid(cfg);
        ensure(
            cells.len().is_multiple_of(4) && cells.len() / 4 <= max_clear_cells(n),
            SpeedexError::InvalidCells,
        );

        // Read the listed cells, in order, into buckets, summing each book as we go.
        let book = self.books.at(&batch);
        let mut buckets: Vec<engine::Bucket> = Vec::with_capacity(cells.len() / 4);
        let mut listed = [0u128; engine::MAX_BOOKS];
        let mut previous: Option<u32> = None;
        for word in cells.as_chunks::<4>().0 {
            let key = u32::from_le_bytes(*word);
            ensure(previous.is_none_or(|p| key > p), SpeedexError::InvalidCells);
            previous = Some(key);
            let (index, level) = ((key >> LEVEL_BITS) as usize, key & ((1 << LEVEL_BITS) - 1));
            let (sell, buy) = (index / MAX_ASSETS, index % MAX_ASSETS);
            ensure(
                sell < n && buy < n && sell != buy && level < grid.levels(),
                SpeedexError::InvalidCells,
            );
            let amount = book
                .at(&key)
                .try_get()
                .none_if_missing()
                .unwrap_or(0)
                .max(0) as u128;
            if amount == 0 {
                continue;
            }
            listed[index] = listed[index].saturating_add(amount);
            buckets.push(engine::Bucket {
                sell: sell as u8,
                buy: buy as u8,
                level,
                limit: grid.ratio(level),
                amount,
            });
        }
        drop(book);

        // Every book's listed cells must account for everything it was offered.
        let totals = self.totals.at(&batch);
        for sell in 0..n {
            for buy in (0..n).filter(|&b| b != sell) {
                let index = engine::book(sell, buy);
                let total = totals
                    .at(&(index as u32))
                    .try_get()
                    .none_if_missing()
                    .unwrap_or(0);
                ensure(
                    listed[index] == total.max(0) as u128,
                    SpeedexError::BatchMismatch,
                );
            }
        }
        drop(totals);
        ensure(!buckets.is_empty(), SpeedexError::BatchEmpty);
        (buckets, listed)
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

        let book = engine::book(offer.sell as usize, offer.buy as usize) as u32;
        let traded = self
            .fills
            .at(&offer.batch)
            .at(&book)
            .try_get()
            .none_if_missing()
            .unwrap_or_default();
        let fill = engine::fill(
            offer.amount,
            offer.level,
            &traded,
            clearing.prices[offer.sell as usize],
            clearing.prices[offer.buy as usize],
        );
        let refunded = offer.amount - fill.sold;

        self.offers.delete_at(id);
        if fill.bought > 0 {
            Self::token(&cfg, offer.buy).transfer(&offer.owner, fill.bought as i128);
        }
        if refunded > 0 {
            Self::token(&cfg, offer.sell).transfer(&offer.owner, refunded as i128);
        }

        log_event(&OfferSettled {
            owner: &offer.owner,
            offer_id: id,
            sold: fill.sold,
            bought: fill.bought,
            refunded,
        });
    }

    pub fn config(&self) -> Config {
        self.cfg()
    }

    /// The batch an offer submitted now would join.
    pub fn current_batch(&self) -> BatchId {
        Self::batch_of_height(&self.cfg())
    }

    /// A batch's clearing, if it has one.
    pub fn clearing(&self, batch: BatchId) -> Option<Clearing> {
        self.clearings.at(&batch).try_get().none_if_missing()
    }

    /// What the orderbook selling `sell` for `buy` traded in a cleared batch; `None` if nothing.
    pub fn book_fill(&self, batch: BatchId, sell: u32, buy: u32) -> Option<BookFill> {
        let book = engine::book(sell as usize, buy as usize) as u32;
        self.fills.at(&batch).at(&book).try_get().none_if_missing()
    }

    /// An offer awaiting settlement, if there is one under this id.
    pub fn offer(&self, id: &OfferId) -> Option<Offer> {
        self.offers.at(id).try_get().none_if_missing()
    }

    /// The grid level a limit of `min_price` would be rounded up to.
    pub fn level_for(&self, min_price: Price) -> u32 {
        Self::grid(&self.cfg())
            .level_for(min_price)
            .unwrap_or_else(|| throw(SpeedexError::InvalidPrice))
    }

    /// The limit ratio (Q32) of a grid level.
    pub fn level_ratio(&self, level: u32) -> Price {
        Self::grid(&self.cfg()).ratio(level)
    }

    /// The histogram cell an offer on the orderbook selling `sell` for `buy` at `level` lands in,
    /// as `clear_batch` expects it listed.
    pub fn cell_of(&self, sell: u32, buy: u32, level: u32) -> u32 {
        cell(engine::book(sell as usize, buy as usize) as u32, level)
    }
}
