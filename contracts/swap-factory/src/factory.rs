//! The factory contract implementation.

use swap_if::*;
use thruput_erc20_if::{ERC20Client, ERC20Error};
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::storage::*;
use thruput_sdk::*;

/// State for the factory contract
#[storage]
pub struct Factory {
    // Code hashes of the contracts the factory deploys (the analog of UniswapV2 compiling in the
    // pair `creationCode`).
    hashes: Value<SwapHashes>,

    // The protocol-fee recipient consulted by every pair (`None` disables it).
    fee_to: Value<Option<Address>>,

    // The router that fronts this factory's pools: each driver it creates takes requests from that
    // address alone.
    router: Value<Address>,

    // Registry: sorted token pair -> pair address, and the creation-ordered list of those token
    // pairs (each one a key into `pairs`, and the input `pool_addresses` resolves back to the rest
    // of the pool's contracts).
    //
    // The list is a `Vector`, whose length is written under an exclusive lock, so this factory
    // creates at most one pool per block: a second `create_pair` in the same block is returned to
    // the mempool and lands in the next. Creation order is inherently serial -- a mergeable counter
    // would hand two concurrent creations the same index -- and pools are created rarely, so the
    // limit is accepted rather than designed around.
    pairs: Map<Addresses, Value<Address>>,
    all_pairs: Vector<Value<Addresses>>,
}

/// How many requests a pool's driver will hold at once.
///
/// This effectively bounds the driver's storage costs, but this is not likely to be a constraint in
/// practice.
///
/// The cap's most important effect is on how long an admitted request might wait, and that matters
/// because admission is irrevocable: a queued request cannot be withdrawn, and it executes against
/// whatever reserves obtain whenever it is finally handled, however stale the quote has become that
/// its slippage limits were chosen against. A request turned away at the ceiling is in a better
/// position: it waits in the mempool, landing as soon as processing makes room; if it instead
/// outlives its own expiry height, that leaves its sender free to resubmit against a fresh quote.
/// So the ceiling is set to a tolerable backlog.
const MAX_QUEUE_LEN: u32 = 256;

/// The most a crank of a pool's queue can be required to clear before it may drain at all.
///
/// Only one crank per block can land, so the block's single drain is worth taking: without a floor,
/// the cheapest way to hold it is a crank funded for one request, which displaces a full one at a
/// fraction of its cost and leaves the queue moving a request per block. A crank therefore owes
/// whatever is waiting, up to this many -- so holding the slot costs about what clearing the queue
/// costs.
///
/// The value trades two failure modes against each other, which is why it is set per pool alongside
/// [`MAX_QUEUE_LEN`] rather than fixed in the driver. Too low leaves an attacker a shallow depth
/// worth parking the queue at; too high prices out the ordinary user who only wants to hurry its
/// own request along, and who must fund this batch as soon as that many are waiting.
const MIN_CRANK_BATCH: u32 = 8;

/// What this factory asks for each of a new pool's three contracts, answered to callers by
/// [`SwapFactory::pool_funding`].
///
/// `min` is a floor that rejects an obviously wrong `funding`, not an estimate of what a pool will
/// spend: bringing one up costs a shade under 84_000 per contract under the default cost model
/// (measured in `tests/factory.rs`), and a driver's queue adds `12_000 + 8 * MAX_QUEUE_LEN` once it
/// fills. It covers both and nothing more.
///
/// `recommended` is room for some 800 storage items per contract -- far more than bring-up and a
/// full queue need, and enough that the handler and the LP token, which grow with the pool's users,
/// will not need topping up for a long while. A caller may pass more for a pool it expects to be
/// busy, or less under a cheaper cost model.
pub const POOL_FUNDING: PoolFunding = PoolFunding {
    min: 128_000,
    recommended: 10_000_000,
};

#[contract(exports = "swap_factory_exports")]
impl SwapFactory for Factory {
    fn initialize(&mut self, hashes: SwapHashes, fee_to: Option<Address>, router: &Address) {
        if self.hashes.try_get().none_if_missing().is_some() {
            throw(SwapFactoryError::AlreadyInitialized);
        }

        self.hashes.set(&hashes);
        self.fee_to.set(&fee_to);
        self.router.set(router);
    }

    fn fee_to(&self) -> Option<Address> {
        self.fee_to.get()
    }

    fn pool_funding(&self) -> PoolFunding {
        POOL_FUNDING
    }

    fn create_pair(&mut self, token_a: &Address, token_b: &Address, funding: Amount) -> Pool {
        let tokens = TokenPair::new(token_a, token_b);
        let [token0, token1] = tokens.as_refs();
        ensure(
            self.get_pair(token0, token1).is_none(),
            SwapFactoryError::PairExists,
        );
        // The only under-funding this contract can catch. A deposit is settled when the transaction
        // commits, so a `funding` that clears this floor but runs out later is not visible from in
        // here -- see the note on the initialization calls below.
        ensure(
            funding >= POOL_FUNDING.min,
            SwapFactoryError::InsufficientFunding,
        );

        // Fund, deploy and initialize the pool, all here. A contract pays for its own storage, so
        // each of these has to hold native tokens before it writes any -- and the funding goes to the address
        // *before* the deploy, since a deployment is itself storage the new contract may be charged
        // for. Deploy addresses are deterministic, so an address can be funded before anything is
        // there.
        //
        // The native tokens come from whoever asked for the pool, on the allowance they granted this
        // contract. Taking it from the factory's own balance would let anyone drain it by creating
        // pools. Distinct salts (per role) keep the child addresses distinct while remaining
        // deterministic in the token pair.
        let hashes = self.hashes.get();
        let payer = get_caller();
        let native = ERC20Client::new(&ADDRESS_NATIVE_TOKEN);
        // This interface counts native-token amounts in `u128`; the token's amounts are `i128`,
        // and no balance can cover anything above `i128::MAX`.
        let funding = i128::try_from(funding).unwrap_or_else(|_| throw(ERC20Error::TooLarge));

        let deploy_funded = |role: Role, hash: &SHA256Hash| -> Address {
            let nonce = tokens.nonce_for(role);
            native.transfer_from(&payer, &get_deploy_address(&nonce, hash), funding);
            deploy_contract(&nonce, hash)
        };

        let liquidity_token = deploy_funded(Role::LP, &hashes.token);
        let handler = deploy_funded(Role::Handler, &hashes.handler);
        let driver = deploy_funded(Role::Driver, &hashes.driver);

        // Initialize and wire them together. A newly deployed contract is callable within this same
        // transaction. These are plain (non-`try`) calls: a callee's failure propagates with its
        // own error type, which is among those mentioned in this trait's `throws` annotation, and
        // aborting here discards the deployments too, so a pool is never left half-built.
        //
        // Commit-locking them (`try_initialize` on a `with_commit_locking` client) would be the
        // obvious way to turn a funding shortfall into an error this contract could report. It
        // cannot be used here: pulling a child's two-phase-commit lock forward to the end of its
        // call weighs that child's storage against the balance committed *before* this transaction,
        // and the funding above is a delta within it. Every `create_pair` would fail, however well
        // funded. Funding a pool in an earlier transaction would let the lock see it, but that is
        // exactly the two-step dance this signature exists to remove.
        //
        // So a shortfall past the floor checked above shows up where storage deposits are always
        // settled: at this transaction's reservation, which returns it to the mempool rather than
        // including a failure in the block. It will retry, and keep failing, until it expires.
        let me = get_current_address();

        SwapHandlerClient::new(&handler).initialize(&me, token0, token1, &liquidity_token, &driver);
        SwapDriverClient::new(&driver).initialize(
            &handler,
            &self.router.get(),
            MAX_QUEUE_LEN,
            MIN_CRANK_BATCH,
        );

        // Record the new pair: by tokens (for `get_pair`) and in creation order (for `pair_at`). A
        // pair is its handler -- that is the contract holding its reserves and performing its
        // operations.
        self.pairs.at_mut(tokens.key()).set(&handler);
        self.all_pairs.push_with(|slot| slot.set(tokens.key()));

        let pool = Pool {
            liquidity_token,
            handler,
            driver,
        };

        log_event(&PoolCreated {
            token0,
            token1,
            liquidity_token,
            handler,
            driver,
            pair_count: self.all_pairs.len(),
        });

        pool
    }

    // The pool's contract addresses: what `create_pair` would deploy for these tokens, and
    // (deployment being deterministic) what it already did deploy if the pair exists.
    fn pool_addresses(&self, token_a: &Address, token_b: &Address) -> Pool {
        let tokens = TokenPair::new(token_a, token_b);
        let hashes = self.hashes.get();
        Pool {
            liquidity_token: get_deploy_address(&tokens.nonce_for(Role::LP), &hashes.token),
            handler: get_deploy_address(&tokens.nonce_for(Role::Handler), &hashes.handler),
            driver: get_deploy_address(&tokens.nonce_for(Role::Driver), &hashes.driver),
        }
    }

    fn get_pair(&self, token_a: &Address, token_b: &Address) -> Option<Address> {
        let tokens = TokenPair::new(token_a, token_b);
        self.pairs.at(tokens.key()).try_get().none_if_missing()
    }

    fn all_pairs_length(&self) -> u32 {
        self.all_pairs.len()
    }

    fn pair_at(&self, index: u32) -> Option<Addresses> {
        if index < self.all_pairs.len() {
            Some(self.all_pairs.at(index).get())
        } else {
            None
        }
    }
}

// Private helpers ...

struct TokenPair {
    tokens: Addresses,
}

impl TokenPair {
    pub fn new(token_a: &Address, token_b: &Address) -> Self {
        ensure(token_a != token_b, SwapFactoryError::IdenticalTokens);

        // Canonical ordering, so the pair is independent of argument order.
        let tokens = if token_a <= token_b {
            [*token_a, *token_b]
        } else {
            [*token_b, *token_a]
        };

        ensure(tokens[0] != Address::zero(), SwapFactoryError::ZeroAddress);

        Self { tokens }
    }

    // Key for the registry
    pub fn key(&self) -> &Addresses {
        &self.tokens
    }

    pub fn as_refs(&self) -> [&Address; 2] {
        [&self.tokens[0], &self.tokens[1]]
    }

    pub fn nonce_for(&self, role: Role) -> SHA256Hash {
        let preimage = ("swap-factory-token-pair", &self.tokens, role);
        preimage.hash()
    }
}

// Deploy-nonce roles, distinguishing the pool's contracts for a token pair.
#[derive(ReadXDR, WriteXDR)]
#[xdr(crate = "thruput_sdk::xdr")]
#[repr(i32)]
enum Role {
    LP = 0,
    Handler = 1,
    Driver = 2,
}
