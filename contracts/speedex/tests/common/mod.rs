//! A three-asset exchange with named users, for the contract tests.

#![allow(unused)]

pub use groundhog_erc20_if::ERC20Client;
pub use sdk::*;
pub use speedex::engine::{self, BookFill, Clearing, Grid, MAX_ROUNDS, PRICE_ONE, Price};
pub use speedex::*;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

hash_ident! { pub static TEST: ContractAddress; }
hash_ident! { pub static ALICE: ContractAddress; }
hash_ident! { pub static BOB: ContractAddress; }
hash_ident! { pub static CAROL: ContractAddress; }
hash_ident! { pub static DAVE: ContractAddress; }
hash_ident! { pub static ERIN: ContractAddress; }
hash_ident! { pub static FRANK: ContractAddress; }

hash_ident! { static TOKEN_A_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_B_NONCE: SHA256Hash; }
hash_ident! { static TOKEN_C_NONCE: SHA256Hash; }
hash_ident! { static EXCHANGE_NONCE: SHA256Hash; }

pub const N: usize = 3;
pub const A: u32 = 0;
pub const B: u32 = 1;
pub const C: u32 = 2;

/// One whole token, at six decimals.
pub const UNIT: u128 = 1_000_000;
/// Limit ratios from 1/4 to just under 4, in 4096 steps to the doubling.
pub const OCTAVES: u32 = 2;
pub const LEVEL_BITS: u32 = 12;
/// The tâtonnement cap the harness configures.
pub const ROUNDS: u32 = 64;
pub const GRID: Grid = Grid {
    octaves: OCTAVES,
    level_bits: LEVEL_BITS,
};

/// A limit or price as a Q32 fixed-point number.
pub fn px(x: f64) -> Price {
    (x * PRICE_ONE as f64).round() as Price
}

pub type Result<T, E = TransactResult> = core::result::Result<T, E>;

/// Run `f` in a transaction as `addr`, returning what it returned if the transaction committed.
pub fn exec<F, T>(env: &TestEnvironmentHandle, addr: &ContractAddress, f: F) -> Result<T>
where
    F: Fn() -> T,
{
    // The closures here borrow the environment they run in, which the executor's unwind boundary
    // cannot know is safe; it is, since a failed transaction is reported, not resumed.
    let f = std::panic::AssertUnwindSafe(f);
    let ret: Arc<Mutex<Option<T>>> = Arc::new(Mutex::new(None));
    let r = env.transact(|tx| {
        tx.call(addr).run(|| {
            *Arc::clone(&ret).lock().unwrap() = Some((*f)());
        })
    });
    if r.is_success() {
        Ok(Arc::into_inner(ret).unwrap().into_inner().unwrap().unwrap())
    } else {
        Err(r)
    }
}

/// The exchange under test, with its three tokens.
pub struct Exchange {
    pub env: TestEnvironmentHandle,
    pub addr: ContractAddress,
    pub tokens: [ContractAddress; N],
    /// The histogram cells each batch's submissions landed in -- what an indexer would know from
    /// the `OfferAccepted` events, and what `clear_batch` is told.
    pub cells: RefCell<BTreeMap<BatchId, BTreeSet<u32>>>,
}

impl Exchange {
    /// A batch per block.
    pub fn setup() -> Self {
        Self::setup_with(1)
    }

    pub fn setup_with(epoch_len: u64) -> Self {
        let env = TestEnvironment::no_cost();
        let token_hash = *erc20::register_mock_contract(&env).as_hash();
        let exchange_hash = *speedex::register_mock_contract(&env).as_hash();

        let (addr, tokens) = exec(&env, &TEST, || {
            let tokens = [
                deploy_contract(&TOKEN_A_NONCE, &token_hash),
                deploy_contract(&TOKEN_B_NONCE, &token_hash),
                deploy_contract(&TOKEN_C_NONCE, &token_hash),
            ];
            for t in &tokens {
                ERC20Client::new(t).initialize(&TEST);
            }

            let addr = deploy_contract(&EXCHANGE_NONCE, &exchange_hash);
            let mut assets = [ContractAddress::new([0; 32]); MAX_ASSETS];
            assets[..N].copy_from_slice(&tokens);
            SpeedexClient::new(&addr)
                .initialize(N as u32, assets, epoch_len, OCTAVES, LEVEL_BITS, ROUNDS);

            (addr, tokens)
        })
        .expect("deploy");
        env.advance_block();

        Self {
            env,
            addr,
            tokens,
            cells: RefCell::new(BTreeMap::new()),
        }
    }

    /// The cell list `clear_batch` expects for `batch`: the cells recorded at submission, packed
    /// little-endian in increasing order.
    pub fn cell_list(&self, batch: BatchId) -> Vec<u8> {
        let cells = self.cells.borrow();
        let set = cells.get(&batch).cloned().unwrap_or_default();
        set.iter().flat_map(|c| c.to_le_bytes()).collect()
    }

    pub fn client(&self) -> SpeedexClient {
        SpeedexClient::new(&self.addr)
    }

    pub fn token(&self, asset: u32) -> ERC20Client {
        ERC20Client::new(&self.tokens[asset as usize])
    }

    pub fn advance_block(&self) {
        self.env.advance_block();
    }

    pub fn as_user<F, T>(&self, user: &ContractAddress, f: F) -> Result<T>
    where
        F: Fn() -> T,
    {
        exec(&self.env, user, f)
    }

    // ── Tokens ──────────────────────────────────────────────────────────────

    /// Mint to a user, and move to the next block so the tokens can be spent. (Every transaction
    /// reads the state its block began with, so a balance minted in one block is spendable and
    /// readable only from the next.)
    pub fn mint(&self, user: &ContractAddress, asset: u32, amount: u128) {
        self.as_user(&TEST, || self.token(asset).mint(user, amount))
            .expect("mint");
        self.advance_block();
    }

    pub fn balances(&self, who: &ContractAddress) -> [u128; N] {
        self.as_user(&TEST, || {
            [A, B, C].map(|asset| self.token(asset).get_balance_of(who))
        })
        .expect("balances")
    }

    /// What the exchange holds in escrow (and dust).
    pub fn pool(&self) -> [u128; N] {
        self.balances(&self.addr)
    }

    // ── Offers ──────────────────────────────────────────────────────────────

    /// As `user`: allow the exchange the amount, and submit the offer.
    pub fn try_submit(
        &self,
        user: &ContractAddress,
        sell: u32,
        buy: u32,
        amount: u128,
        min_price: Price,
    ) -> Result<OfferId, CallError> {
        let batch = self.current_batch();
        let result = self
            .as_user(user, || {
                self.token(sell)
                    .adjust_allowance(&self.addr, amount as i128, false);
                self.client().try_submit_offer(sell, buy, amount, min_price)
            })
            .expect("submit transaction");
        if result.is_ok() {
            let level = GRID.level_for(min_price).expect("on the grid");
            let cell = (engine::book(sell as usize, buy as usize) as u32) << 20 | level;
            self.cells
                .borrow_mut()
                .entry(batch)
                .or_default()
                .insert(cell);
        }
        result
    }

    pub fn submit(
        &self,
        user: &ContractAddress,
        sell: u32,
        buy: u32,
        amount: u128,
        min_price: Price,
    ) -> OfferId {
        self.try_submit(user, sell, buy, amount, min_price)
            .expect("submit_offer")
    }

    pub fn try_cancel(&self, user: &ContractAddress, id: &OfferId) -> Result<(), CallError> {
        self.as_user(user, || self.client().try_cancel_offer(id))
            .expect("cancel transaction")
    }

    pub fn try_clear(&self, batch: BatchId) -> Result<Clearing, CallError> {
        self.try_clear_with(batch, &self.cell_list(batch))
    }

    pub fn try_clear_with(&self, batch: BatchId, cells: &[u8]) -> Result<Clearing, CallError> {
        self.as_user(&DAVE, || self.client().try_clear_batch(batch, cells))
            .expect("clear transaction")
    }

    pub fn clear(&self, batch: BatchId) -> Clearing {
        self.try_clear(batch).expect("clear_batch")
    }

    pub fn try_settle(&self, id: &OfferId) -> Result<(), CallError> {
        self.as_user(&DAVE, || self.client().try_settle_offer(id))
            .expect("settle transaction")
    }

    pub fn settle(&self, id: &OfferId) {
        self.try_settle(id).expect("settle_offer")
    }

    pub fn current_batch(&self) -> BatchId {
        self.as_user(&TEST, || self.client().current_batch())
            .expect("current_batch")
    }

    pub fn offer(&self, id: &OfferId) -> Option<Offer> {
        self.as_user(&TEST, || self.client().offer(id))
            .expect("offer")
    }

    /// Advance until `batch` has closed, clear it, and move on a block so the clearing is readable.
    pub fn close_and_clear(&self, batch: BatchId) -> Clearing {
        while self.current_batch() <= batch {
            self.advance_block();
        }
        let clearing = self.clear(batch);
        self.advance_block();
        clearing
    }

    /// Settle all of these offers in one block -- settlements commute -- then move on a block so
    /// the payouts are readable.
    pub fn settle_all(&self, ids: &[OfferId]) {
        for id in ids {
            self.settle(id);
        }
        self.advance_block();
    }

    /// Advance to the first block of the next epoch, so that offers submitted over the next
    /// `epoch_len - 1` blocks share a batch.
    pub fn start_of_next_epoch(&self) -> BatchId {
        let batch = self.current_batch();
        while self.current_batch() == batch {
            self.advance_block();
        }
        self.current_batch()
    }
}

/// The error a failed call raised, as a `SpeedexError`.
pub fn speedex_error(r: Result<impl core::fmt::Debug, CallError>) -> SpeedexError {
    match r {
        Ok(v) => panic!("expected an error, got {v:?}"),
        Err(e) => e
            .try_as()
            .unwrap_or_else(|| panic!("not a SpeedexError: {e:?}")),
    }
}

/// `p_sell / p_buy` from a clearing, as a float.
pub fn ratio(c: &Clearing, sell: u32, buy: u32) -> f64 {
    c.prices[sell as usize] as f64 / c.prices[buy as usize] as f64
}
