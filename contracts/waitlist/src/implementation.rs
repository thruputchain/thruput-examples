use fee_market::{FeeMarket, InitError};
use thruput_erc20_if::{ERC20Client, ERC20Error};
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::{Balance, Node};
use thruput_sdk::*;

#[contract_exception]
pub enum WaitlistError {
    /// `initialize` was given a target of zero.
    ZeroTarget = 1,
    /// `initialize` was called on a waitlist that is already running.
    AlreadyInitialized = 2,
    /// `initialize` was given a maximum fee of zero.
    ZeroMaxFee = 3,
}

/// A waitlist whose entry fee is steered by how many are waiting.
///
/// The fee is a `FeeMarket`'s, and the load it steers by is the backlog: free while no more than
/// the target are waiting, rising by up to an eighth in each block that starts with more, up to a
/// maximum, and falling back in each that starts with fewer. Concurrent joins never conflict -- not over the
/// backlog, which is a `Balance` they only add to, and not over the fee, which every join in a
/// block computes and records alike from the backlog at the block's start.
#[thruput_sdk::storage]
pub struct Waitlist {
    waiting: Balance,
    fee: Node<FeeMarket>,
}

#[contract(throws(WaitlistError, ERC20Error))]
impl Waitlist {
    /// Start the fee, steering toward a backlog of `target`, and never charging more than
    /// `max_fee`. Callable once.
    ///
    /// A backlog nobody serves raises the fee in every block; the maximum is what bounds it. Anyone
    /// may `serve`, so anyone can bring it back down.
    pub fn initialize(&mut self, target: u32, max_fee: u128) {
        self.fee.initialize(target, max_fee).unwrap_or_else(|e| {
            throw(match e {
                InitError::ZeroTarget => WaitlistError::ZeroTarget,
                InitError::ZeroMaxFee => WaitlistError::ZeroMaxFee,
                InitError::AlreadyInitialized => WaitlistError::AlreadyInitialized,
            })
        });
    }

    /// Join the list, paying the current fee. Returns the fee paid.
    ///
    /// The fee is paid in native tokens, on an allowance the caller grants this contract, and
    /// stays here. A fee of zero is not collected, so no allowance is needed for it.
    pub fn join(&mut self) -> u128 {
        // The backlog as of this block's start: read before this join adds to it, so that every
        // join in the block passes the same load.
        let backlog = self.backlog();
        let fee = self.fee.update(backlog);

        if fee > 0 {
            // A fee never exceeds `fee_market::MAX_FEE`, so it fits the token's `i128`.
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).transfer_from(
                &get_caller(),
                &get_current_address(),
                fee as i128,
            );
        }

        self.waiting.increase(1);
        fee
    }

    /// Serve up to `count` of those waiting, returning how many were served. Anyone may serve.
    pub fn serve(&mut self, count: u32) -> u32 {
        let waiting = self.backlog();

        // Serving changes the backlog, so record the fee in this block too: a market updated in
        // every block that changes its load keeps an exact fee across blocks nobody joins in.
        self.fee.update(waiting);

        let served = waiting.min(u128::from(count)) as u32;
        self.waiting.decrease(i128::from(served));
        served
    }

    /// How many are waiting.
    pub fn waiting(&self) -> u64 {
        self.waiting.get() as u64
    }

    /// What joining costs in this block.
    pub fn fee(&self) -> u128 {
        self.fee.quote(self.backlog())
    }

    // The backlog: as of this block's start, plus whatever this transaction has changed.
    fn backlog(&self) -> u128 {
        self.waiting.get() as u128
    }
}
