use alloc::vec::Vec;
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::deletable::Deletable;
use thruput_sdk::storage::{Balance, Map, NNInt, Value};
use thruput_sdk::*;

/// The most price levels a ladder can have. It bounds what a claim reads: two balances a level.
pub const MAX_LEVELS: u32 = 32;

/// The price of a lot at each level, in payment-token base units, from the reserve up.
pub type Ladder = VecM<u64, MAX_LEVELS>;

/// A number of lots at each level of the ladder.
pub type Lots = VecM<i128, MAX_LEVELS>;

/// What a seller offers, and on what terms. Fixed when the auction starts.
#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    /// The token for sale.
    pub sale_token: ContractAddress,

    /// The token bids are paid in. The native token works like any other.
    pub payment_token: ContractAddress,

    /// How many base units of the sale token make one lot. Everything is bid and sold in lots.
    pub lot_size: i128,

    /// How many lots are for sale.
    pub supply: u64,

    /// The fewest lots one bid may ask for.
    pub min_lots: u64,

    /// The price of a lot at each level: strictly increasing, and positive. Level 0 is the
    /// reserve, the lowest price the seller accepts.
    pub prices: Ladder,

    /// When bidding closes, as a block timepoint in Unix nanoseconds. A block whose timepoint is
    /// at or after this takes no bids, and is the first that can settle them.
    pub end: u64,

    /// The native tokens a bidder deposits for each level it bids at, returned when its bids are
    /// claimed.
    ///
    /// A bidder's first bid at a level opens an entry in this contract's storage, and storage is
    /// paid for out of this contract's native tokens until the entry is deleted. The bond is what
    /// makes the bidder pay for it instead: set it to at least the network's storage cost of one
    /// data item. A bond of zero leaves the auction paying for every entry anyone opens, so that
    /// anyone can drain its native tokens with bids.
    pub entry_bond: i128,
}

#[contract_type]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Auction {
    /// Who started the auction: the sale tokens came from them, and the proceeds go to them.
    pub seller: ContractAddress,
    pub terms: Terms,
}

/// Where the demand curve meets the supply.
///
/// Every bid strictly above `level` is filled in full; every bid below it is refunded in full;
/// the bids at `level` share what is left of the supply, in proportion to their size. Everyone
/// filled pays `price` a lot, whatever they bid.
#[contract_type]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clearing {
    /// The clearing level: the highest at which the bids at or above it ask for the whole
    /// supply, or the reserve if no level's do.
    pub level: u32,

    /// The price every filled lot pays: the clearing level's.
    pub price: u64,

    /// Lots bid strictly above the clearing level, all of which are filled.
    pub above: i128,

    /// Lots bid at the clearing level.
    pub at_level: i128,

    /// How many of the lots at the clearing level are filled: what the bids above it leave of the
    /// supply, or all of them if that is more.
    pub filled_at_level: i128,

    /// Lots nobody bid for at or above the reserve.
    pub unsold: i128,
}

impl Clearing {
    /// Whether the bids at the clearing level ask for more than is left for them, and so are
    /// filled in part.
    pub fn rationed(&self) -> bool {
        self.filled_at_level < self.at_level
    }

    /// How many of `lots`, bid at `level`, are filled.
    ///
    /// A share of a rationed level is rounded down, so the shares never add up to more than is
    /// left for them; the few lots that rounding leaves over go back to the seller.
    pub fn filled(&self, level: u32, lots: i128) -> i128 {
        if level > self.level || (level == self.level && !self.rationed()) {
            lots
        } else if level == self.level {
            // `lots <= at_level` and `filled_at_level < at_level`, so the quotient is less than
            // `lots`. The product takes a 256-bit intermediate.
            mul_div_u128(
                lots as u128,
                self.filled_at_level as u128,
                self.at_level as u128,
            ) as i128
        } else {
            0
        }
    }
}

/// What one claim settled for one bidder, over all their bids.
#[contract_type]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Settlement {
    /// Lots filled, delivered as `lots * lot_size` sale-token base units.
    pub lots: i128,

    /// What the filled lots cost at the clearing price, paid to the seller.
    pub paid: i128,

    /// The rest of the bidder's escrow, returned to them.
    pub refund: i128,

    /// The bidder's entry bonds, in native tokens, returned to them.
    pub bonds: i128,
}

#[contract_exception]
pub enum AuctionError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// The terms are not a sale anyone could bid in: see `initialize`.
    InvalidTerms = 3,
    /// The block's timepoint is at or past the end: bidding is over.
    BiddingClosed = 4,
    /// The block's timepoint is before the end: nothing can be settled yet.
    BiddingOpen = 5,
    NoSuchLevel = 6,
    /// A bid for fewer lots than the terms' `min_lots`.
    BidTooSmall = 7,
    /// An amount too large to represent.
    TooLarge = 8,
    /// The bidder has no bids left to claim.
    NothingToClaim = 9,
    /// What the rationed level leaves over is not known until every bid there is claimed.
    RationedBidsUnclaimed = 10,
    AlreadyReturned = 11,
    /// The auction does not hold the native tokens `initialize` asks for.
    ReserveTooSmall = 12,
}

#[derive(Event, Clone, Debug)]
pub struct BidPlaced {
    #[topic]
    pub bidder: ContractAddress,
    #[topic]
    pub level: u32,
    pub lots: u64,
    pub escrow: i128,
}

#[derive(Event, Clone, Debug)]
pub struct Claimed {
    #[topic]
    pub bidder: ContractAddress,
    pub lots: i128,
    pub paid: i128,
    pub refund: i128,
}

#[derive(Event, Clone, Debug)]
pub struct UnsoldReturned {
    pub lots: i128,
}

/// The native tokens, in entry bonds, an auction must hold when it starts.
///
/// Two bonds a level, and eight more. `initialize` stores the terms, a demand total a level, and
/// three small values, and a bond is meant to cover one item; the terms take more than one. The
/// other bond a level is room for a claim to refund a bidder's bonds: the entries the claim
/// deletes give their deposits back only when it commits, so the refund has to come out of tokens
/// the auction already holds.
pub fn reserve_needed(levels: u32, entry_bond: i128) -> i128 {
    (2 * i128::from(levels) + 8).saturating_mul(entry_bond)
}

/// A uniform-price auction whose bids are additions on a fixed price ladder.
///
/// A bid names a level of the ladder and a number of lots. It escrows what those lots would cost
/// at that level's price, and adds the lots to two balances: the level's total demand, and the
/// bidder's own lots at that level. It reads neither total. So concurrent bids do not conflict,
/// and their order in a block cannot change anything: the state after a block is the same however
/// its bids were ordered, and so is the outcome.
///
/// Once bidding closes the demand curve is fixed, and the clearing price is a pure function of it
/// (see [`Clearing`]). No one has to settle the auction: each claim computes the clearing from the
/// curve, which costs a read a level, and pays out one bidder. Claims for different bidders do not
/// conflict either; a claim for a bidder already claimed for cannot commit.
///
/// Everything the auction itself stores is created by `initialize`, and paid for by the seller.
/// The only storage anyone else creates is their own bid entries, which their bonds pay for.
#[thruput_sdk::storage]
pub struct LadderAuction {
    auction: Value<Auction>,

    // Lots bid at each level, by everyone. Set to zero by `initialize`, and then only added to.
    //
    // Created up front, because a key that many transactions in one block find missing is
    // created by each of them: each holds a deposit for it until the block closes. A crowd
    // bidding at a fresh level in one block would need a deposit apiece.
    demand: Map<u32, NNInt>,

    // Each bidder's lots at each level: opened by its first bid there, added to by later ones,
    // and deleted by the claim that settles them.
    bids: Map<ContractAddress, Map<u32, Balance>>,

    // Of the lots at a rationed clearing level: how many have been claimed, and how many of those
    // were filled. When all are claimed, the difference between what the level was left and what
    // it filled is what rounding left over. Set to zero by `initialize`, like the demand.
    rationed_claimed: NNInt,
    rationed_filled: NNInt,

    unsold_returned: Value<bool>,
}

impl LadderAuction {
    fn load(&self) -> Auction {
        self.auction
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(AuctionError::NotInitialized))
    }

    fn now() -> u64 {
        get_block_timepoint().into_inner()
    }

    fn valid(terms: &Terms, here: &ContractAddress) -> bool {
        let tokens = [terms.sale_token, terms.payment_token];
        !terms.prices.is_empty()
            && terms.prices[0] > 0
            && terms.prices.windows(2).all(|pair| pair[0] < pair[1])
            && terms.lot_size > 0
            && terms.supply > 0
            && terms.min_lots > 0
            && terms.entry_bond >= 0
            && terms.end > Self::now()
            && terms.sale_token != terms.payment_token
            && tokens
                .iter()
                .all(|token| *token != ContractAddress::default() && token != here)
    }

    // The clearing for the demand as of this block's start.
    //
    // Walk down from the top level, adding up demand, until the bids at or above a level ask for
    // the whole supply; that level clears. If none does, the reserve clears, and whatever the bids
    // do not ask for is unsold. At most one read a level.
    fn clear(&self, terms: &Terms) -> Clearing {
        let supply = i128::from(terms.supply);
        let at = |level: u32| self.demand.at(&level).get();
        let add = |a: i128, b: i128| {
            a.checked_add(b)
                .unwrap_or_else(|| throw(AuctionError::TooLarge))
        };

        let mut above = 0;
        for level in (1..terms.prices.len() as u32).rev() {
            let at_level = at(level);
            let through = add(above, at_level);
            if through >= supply {
                return Clearing {
                    level,
                    price: terms.prices[level as usize],
                    above,
                    at_level,
                    filled_at_level: supply - above,
                    unsold: 0,
                };
            }
            above = through;
        }

        let at_level = at(0);
        let through = add(above, at_level);
        Clearing {
            level: 0,
            price: terms.prices[0],
            above,
            at_level,
            filled_at_level: at_level.min(supply - above),
            unsold: (supply - through).max(0),
        }
    }
}

#[contract(
    throws(AuctionError, thruput_erc20_if::ERC20Error),
    emits(BidPlaced, Claimed, UnsoldReturned)
)]
impl LadderAuction {
    /// Start the auction: the caller is the seller, and the supply is taken from them now, on an
    /// allowance of `supply * lot_size` sale tokens granted to this contract. Call it in the
    /// transaction that deploys the contract.
    ///
    /// The terms must name two different tokens, neither of them this contract; a positive lot
    /// size, supply and minimum bid; a ladder of strictly increasing positive prices; a bond that
    /// is not negative; and an end in the future. The contract must already hold the native
    /// tokens [`reserve_needed`] asks for: send them to its address before deploying it, or
    /// earlier in the same transaction.
    pub fn initialize(&mut self, terms: Terms) {
        ensure(
            self.auction.try_get().none_if_missing().is_none(),
            AuctionError::AlreadyInitialized,
        );
        let here = get_current_address();
        ensure(Self::valid(&terms, &here), AuctionError::InvalidTerms);
        let total = i128::from(terms.supply)
            .checked_mul(terms.lot_size)
            .unwrap_or_else(|| throw(AuctionError::InvalidTerms));
        ensure(
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).get_balance_of(&here)
                >= reserve_needed(terms.prices.len() as u32, terms.entry_bond),
            AuctionError::ReserveTooSmall,
        );

        let seller = get_caller();
        self.auction.set_exclusive(&Auction {
            seller,
            terms: terms.clone(),
        });
        for level in 0..terms.prices.len() as u32 {
            self.demand.at_mut(&level).set(0);
        }
        self.rationed_claimed.set(0);
        self.rationed_filled.set(0);
        self.unsold_returned.set(&false);
        ERC20Client::new(&terms.sale_token).transfer_from(&seller, &here, total);
    }

    /// Bid for `lots` lots at `level`, escrowing what they cost at that level's price, on an
    /// allowance of the payment token granted to this contract. Returns the escrow.
    ///
    /// The first bid a bidder makes at a level also takes the terms' entry bond, in native tokens,
    /// on an allowance of those. Two first bids at one level in one block cannot both commit:
    /// whichever does not can be sent again, and is then a later bid.
    ///
    /// A bid is a limit: it is filled at the clearing price, which is never above its own, and
    /// whatever the escrow does not pay for is refunded. Bids add up, and cannot be withdrawn.
    pub fn bid(&mut self, level: u32, lots: u64) -> i128 {
        let terms = self.load().terms;
        ensure(Self::now() < terms.end, AuctionError::BiddingClosed);
        let price = *terms
            .prices
            .get(level as usize)
            .unwrap_or_else(|| throw(AuctionError::NoSuchLevel));
        ensure(lots >= terms.min_lots, AuctionError::BidTooSmall);
        let escrow = i128::try_from(u128::from(lots) * u128::from(price))
            .unwrap_or_else(|_| throw(AuctionError::TooLarge));

        let bidder = get_caller();
        let here = get_current_address();
        ERC20Client::new(&terms.payment_token).transfer_from(&bidder, &here, escrow);

        // The bidder's own entry is the one thing a bid reads, and only to learn whether this bid
        // opens it. Opening takes the bond, and an exclusive lock, so an entry is bonded exactly
        // once: two bids that both found it empty conflict.
        let lots_i = i128::from(lots);
        let mut own = self.bids.at_mut(&bidder);
        if own.at(&level).get() == 0 {
            if terms.entry_bond > 0 {
                ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
                    &bidder,
                    &here,
                    terms.entry_bond,
                );
            }
            own.at_mut_exclusive(&level).lazy_increase(lots_i);
        } else {
            own.at_mut(&level).lazy_increase(lots_i);
        }

        // An addition, and nothing read: bids from anyone, in any number, merge here rather than
        // conflict, and none can see another in its block. So nothing about a bid depends on what
        // was ordered before it.
        self.demand.at_mut(&level).inc(lots_i);

        log_event(&BidPlaced {
            bidder,
            level,
            lots,
            escrow,
        });
        escrow
    }

    /// Settle every bid `bidder` made: deliver the lots filled, pay the seller for them at the
    /// clearing price, and refund the rest of the escrow and the entry bonds. Anyone may claim for
    /// anyone, since the tokens only ever go to the bidder and the seller.
    pub fn claim(&mut self, bidder: &ContractAddress) -> Settlement {
        let Auction { seller, terms } = self.load();
        ensure(Self::now() >= terms.end, AuctionError::BiddingOpen);
        let clearing = self.clear(&terms);

        let mut settlement = Settlement::default();
        let mut entries = 0;
        let add = |a: i128, b: i128| {
            a.checked_add(b)
                .unwrap_or_else(|| throw(AuctionError::TooLarge))
        };
        for (index, price) in terms.prices.iter().enumerate() {
            let level = index as u32;
            let lots = {
                let mut own = self.bids.at_mut(bidder);
                let mut entry = own.at_mut(&level);
                let lots = entry.get();
                if lots == 0 {
                    continue;
                }
                // The exclusive delete is what makes a claim happen once. Two claims for the same
                // bidder in one block both read these lots, but both cannot delete them: the
                // second conflicts, and cannot commit. In any later block, they are gone. (A
                // plain delete would not do: two deletes of one key do not conflict.)
                entry.delete_exclusive();
                lots
            };
            entries += 1;

            // The escrow for these lots was paid in, and is held by this contract, so it fits.
            let escrow = lots
                .checked_mul(i128::from(*price))
                .unwrap_or_else(|| throw(AuctionError::TooLarge));
            let filled = clearing.filled(level, lots);
            // Filled lots are at or above the clearing level, whose price is no higher than
            // theirs: the payment never exceeds the escrow.
            let paid = filled * i128::from(clearing.price);

            settlement.lots = add(settlement.lots, filled);
            settlement.paid = add(settlement.paid, paid);
            settlement.refund = add(settlement.refund, escrow - paid);

            if level == clearing.level && clearing.rationed() {
                self.rationed_claimed.inc(lots);
                self.rationed_filled.inc(filled);
            }
        }
        ensure(entries > 0, AuctionError::NothingToClaim);
        settlement.bonds = entries * terms.entry_bond;

        // All the state is written; now the transfers. Filled lots are part of the supply, whose
        // size in base units was checked when the auction started.
        if settlement.lots > 0 {
            ERC20Client::new(&terms.sale_token).transfer(bidder, settlement.lots * terms.lot_size);
        }
        let payment = ERC20Client::new(&terms.payment_token);
        if settlement.refund > 0 {
            payment.transfer(bidder, settlement.refund);
        }
        if settlement.paid > 0 {
            payment.transfer(&seller, settlement.paid);
        }
        if settlement.bonds > 0 {
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer(bidder, settlement.bonds);
        }

        log_event(&Claimed {
            bidder: *bidder,
            lots: settlement.lots,
            paid: settlement.paid,
            refund: settlement.refund,
        });
        settlement
    }

    /// Return the lots nobody bought to the seller, once. Returns how many there were. Anyone may
    /// call it, since the tokens only ever go to the seller.
    ///
    /// If the bids do not ask for the whole supply, the rest is known as soon as bidding closes.
    /// If the clearing level is rationed, rounding its shares down leaves a few lots over, and how
    /// many is known only once every bid at that level has been claimed. Since anyone may claim
    /// for anyone, the seller can make sure of that.
    pub fn return_unsold(&mut self) -> i128 {
        let Auction { seller, terms } = self.load();
        ensure(Self::now() >= terms.end, AuctionError::BiddingOpen);
        ensure(!self.has_returned_unsold(), AuctionError::AlreadyReturned);
        let clearing = self.clear(&terms);

        let lots = if clearing.rationed() {
            // Read as of this block's start. If every lot at the rationed level has been claimed
            // by then, no claim in this block can find one, so the count is final.
            ensure(
                self.rationed_claimed.get() == clearing.at_level,
                AuctionError::RationedBidsUnclaimed,
            );
            clearing.filled_at_level - self.rationed_filled.get()
        } else {
            clearing.unsold
        };

        // Exclusive, like a claim's delete: two returns in one block cannot both commit.
        self.unsold_returned.set_exclusive(&true);
        if lots > 0 {
            ERC20Client::new(&terms.sale_token).transfer(&seller, lots * terms.lot_size);
        }
        log_event(&UnsoldReturned { lots });
        lots
    }

    pub fn auction(&self) -> Auction {
        self.load()
    }

    /// The clearing as it stands: final once bidding has closed, and before that, what it would
    /// be if bidding closed now.
    pub fn clearing(&self) -> Clearing {
        self.clear(&self.load().terms)
    }

    /// Lots bid at each level, by everyone.
    pub fn demand(&self) -> Lots {
        let levels = self.load().terms.prices.len() as u32;
        VecM(
            (0..levels)
                .map(|level| self.demand.at(&level).get())
                .collect::<Vec<_>>(),
        )
    }

    /// `bidder`'s unclaimed lots at each level.
    pub fn bids_of(&self, bidder: &ContractAddress) -> Lots {
        let levels = self.load().terms.prices.len() as u32;
        VecM(
            (0..levels)
                .map(|level| self.bids.at(bidder).at(&level).get())
                .collect::<Vec<_>>(),
        )
    }

    pub fn has_returned_unsold(&self) -> bool {
        self.unsold_returned
            .try_get()
            .none_if_missing()
            .unwrap_or(false)
    }
}
