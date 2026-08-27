//! The factory contract implementation.

use crate::events::*;
use sdk::storage::*;
use sdk::*;
use swap_if::*;

/// State for the factory contract
#[storage]
pub struct Factory {
    // Code hashes of the contracts the factory deploys (the analog of
    // UniswapV2 compiling in the pair `creationCode`).
    hashes: Value<SwapHashes>,

    // The protocol-fee recipient consulted by every pair (`None` disables it).
    fee_to: Value<Option<Address>>,

    // Registry: sorted token pair -> pair address, and the creation-ordered
    // list of those token pairs (each one a key into `pairs`, and the input
    // `pool_addresses` resolves back to the rest of the pool's contracts).
    pairs: Map<Addresses, Value<Address>>,
    all_pairs: Vector<Value<Addresses>>,
}

/// How many requests a pool's driver will hold at once.
///
/// This effectively bounds the driver's storage costs, but this is not likely
/// to be a constraint in practice.
///
/// The cap's most important effect is on how long an admitted request might
/// wait, and that matters because admission is irrevocable: a queued request
/// cannot be withdrawn, and it executes against whatever reserves obtain
/// whenever it is finally handled, however stale the quote has become that its
/// slippage limits were chosen against.  A request turned away at the ceiling
/// is in a better position: it waits in the mempool, landing as soon as
/// processing makes room; if it instead outlives its own expiry height, that
/// leaves its sender free to resubmit against a fresh quote. So the ceiling is
/// set to a tolerable backlog.
const MAX_QUEUE_LEN: u32 = 256;

/// The most a crank of a pool's queue can be required to clear before it may
/// drain at all.
///
/// Only one crank per block can land, so the block's single drain is worth
/// taking: without a floor, the cheapest way to hold it is a crank funded for
/// one request, which displaces a full one at a fraction of its cost and leaves
/// the queue moving a request per block.  A crank therefore owes whatever is
/// waiting, up to this many -- so holding the slot costs about what clearing
/// the queue costs.
///
/// The value trades two failure modes against each other, which is why it is
/// set per pool alongside [`MAX_QUEUE_LEN`] rather than fixed in the driver.
/// Too low leaves an attacker a shallow depth worth parking the queue at; too
/// high prices out the ordinary user who only wants to hurry its own request
/// along, and who must fund this batch as soon as that many are waiting.
const MIN_CRANK_BATCH: u32 = 8;

#[contract(exports = "swap_factory_exports")]
impl SwapFactory for Factory {
    fn initialize(&mut self, hashes: SwapHashes, fee_to: Option<Address>) {
        if self.hashes.try_get().none_if_missing().is_some() {
            throw(SwapFactoryError::AlreadyInitialized);
        }

        self.hashes.set(&hashes);
        self.fee_to.set(&fee_to);
    }

    fn fee_to(&self) -> Option<Address> {
        self.fee_to.get()
    }

    fn create_pair(&mut self, token_a: &Address, token_b: &Address) -> Pool {
        let tokens = TokenPair::new(token_a, token_b);
        let [token0, token1] = tokens.as_refs();
        ensure(
            self.get_pair(token0, token1).is_none(),
            SwapFactoryError::PairExists,
        );

        // Deploy the pool.  Distinct salts (per role) keep the child addresses
        // distinct while remaining deterministic in the token pair.
        let hashes = self.hashes.get();
        let liquidity_token = deploy_contract(&tokens.nonce_for(Role::LP), &hashes.token);
        let pair = deploy_contract(&tokens.nonce_for(Role::Pair), &hashes.pair);
        let handler = deploy_contract(&tokens.nonce_for(Role::Handler), &hashes.handler);
        let driver = deploy_contract(&tokens.nonce_for(Role::Driver), &hashes.driver);

        // Initialize and wire them together.  A newly deployed contract is
        // callable within this same transaction.  These are plain (non-`try`)
        // calls: a callee's failure propagates with its own error type, which
        // is among those mentioned in this trait's `throws` annotation.
        let me = get_current_address();
        SwapPairClient::new(&pair).initialize(&me, token0, token1, &liquidity_token);
        SwapHandlerClient::new(&handler).initialize(&pair, token0, token1);
        SwapDriverClient::new(&driver).initialize(&handler, MAX_QUEUE_LEN, MIN_CRANK_BATCH);

        // Record the new pair: by tokens (for `get_pair`) and in creation
        // order (for `pair_at`).
        self.pairs.at_mut(tokens.key()).set(&pair);
        self.all_pairs.push_with(|slot| slot.set(tokens.key()));

        let pool = Pool {
            liquidity_token,
            pair,
            handler,
            driver,
        };

        log_event(&PoolCreated {
            token0,
            token1,
            pair,
            liquidity_token,
            handler,
            driver,
            pair_count: self.all_pairs.len(),
        });

        pool
    }

    // The pool's contract addresses: what `create_pair` would deploy for these
    // tokens, and (deployment being deterministic) what it already did deploy
    // if the pair exists.
    fn pool_addresses(&self, token_a: &Address, token_b: &Address) -> Pool {
        let tokens = TokenPair::new(token_a, token_b);
        let hashes = self.hashes.get();
        Pool {
            liquidity_token: get_deploy_address(&tokens.nonce_for(Role::LP), &hashes.token),
            pair: get_deploy_address(&tokens.nonce_for(Role::Pair), &hashes.pair),
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
#[xdr(crate = "sdk::xdr")]
#[repr(i32)]
enum Role {
    LP = 0,
    Pair = 1,
    Handler = 2,
    Driver = 3,
}
