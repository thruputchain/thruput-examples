//! The factory contract implementation.

use crate::events::*;
use sdk::crypto::sha256;
use sdk::storage::*;
use sdk::*;
use swap_if::*;

// Clients for the contracts we deploy and initialize.
use swap_driver::SwapDriverClient;
use swap_pair::SwapPairClient;
use swap_request::RequestHandlerClient;
use swap_router::RouterClient;

/// State for the factory contract
#[storage]
pub struct Factory {
    // Code hashes of the contracts the factory deploys (the analog of
    // UniswapV2 compiling in the pair `creationCode`).
    hashes: Value<SwapHashes>,

    // The protocol-fee recipient consulted by every pair (`None` disables it).
    fee_to: Value<Option<Address>>,

    // Registry: sorted token pair -> pair address, and creation-ordered list.
    pairs: Map<[Address; 2], Value<Address>>,
    all_pairs: Vector<Value<Address>>,
}

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

    fn create_pair(&mut self, token_a: &Address, token_b: &Address) -> Suite {
        ensure(token_a != token_b, SwapFactoryError::IdenticalTokens);

        // Canonical ordering, so the pair is independent of argument order.
        let [token0, token1] = sorted(token_a, token_b);
        ensure(token0 != Address::zero(), SwapFactoryError::ZeroAddress);
        ensure(
            self.get_pair(&token0, &token1).is_none(),
            SwapFactoryError::PairExists,
        );

        // Deploy the suite.  Distinct salts (per role) keep the child addresses
        // distinct while remaining deterministic in the token pair.
        let hashes = self.hashes.get();
        let lp = deploy_contract(&salt(&token0, &token1, 0), &hashes.token);
        let pair = deploy_contract(&salt(&token0, &token1, 1), &hashes.pair);
        let handler = deploy_contract(&salt(&token0, &token1, 2), &hashes.handler);
        let driver = deploy_contract(&salt(&token0, &token1, 3), &hashes.driver);
        let router = deploy_contract(&salt(&token0, &token1, 4), &hashes.router);

        // Initialize and wire them together.  A newly deployed contract is
        // callable within this same transaction.  We use the `try_*` calls and
        // collapse any callee error to `SuiteInitFailed`, since this crate
        // cannot name the callees' error types without a dependency cycle.
        let me = get_current_address();
        SwapPairClient::new(&pair)
            .try_initialize(&me, &token0, &token1, &lp)
            .unwrap_or_else(|_| throw(SwapFactoryError::SuiteInitFailed));
        RequestHandlerClient::new(&handler)
            .try_initialize(&pair, &token0, &token1)
            .unwrap_or_else(|_| throw(SwapFactoryError::SuiteInitFailed));
        SwapDriverClient::new(&driver)
            .try_initialize(&handler)
            .unwrap_or_else(|_| throw(SwapFactoryError::SuiteInitFailed));
        RouterClient::new(&router)
            .try_initialize(&driver, &token0, &token1)
            .unwrap_or_else(|_| throw(SwapFactoryError::SuiteInitFailed));

        // Record the new pair.
        self.pairs.at_mut(&[token0, token1]).set(&pair);
        self.all_pairs.push_with(|slot| slot.set(&pair));

        let suite = Suite {
            pair,
            liquidity_token: lp,
            handler,
            driver,
            router,
        };

        log_event(&SuiteCreated {
            token0: &token0,
            token1: &token1,
            pair,
            liquidity_token: lp,
            handler,
            driver,
            router,
            pair_count: self.all_pairs.len(),
        });

        suite
    }

    fn get_pair(&self, token_a: &Address, token_b: &Address) -> Option<Address> {
        let key = sorted(token_a, token_b);
        self.pairs.at(&key).try_get().none_if_missing()
    }

    fn all_pairs_length(&self) -> u32 {
        self.all_pairs.len()
    }

    fn pair_at(&self, index: u32) -> Address {
        self.all_pairs.at(index).get()
    }
}

// The two tokens in canonical (ascending) order.
fn sorted(token_a: &Address, token_b: &Address) -> [Address; 2] {
    if token_a <= token_b {
        [*token_a, *token_b]
    } else {
        [*token_b, *token_a]
    }
}

// A deterministic, per-role deploy salt for a token pair.
fn salt(token0: &Address, token1: &Address, role: u8) -> SHA256Hash {
    let mut preimage = [0u8; 65];
    preimage[..32].copy_from_slice(token0.as_ref());
    preimage[32..64].copy_from_slice(token1.as_ref());
    preimage[64] = role;
    sha256(&preimage)
}
