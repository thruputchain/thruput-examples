//! A contract implementing ISwapV2Driver

#![allow(clippy::result_large_err)]

use crate::cfg::*;
use crate::request::*;
use sdk::storage::*;
use sdk::*;
use swap::*;

// Limits derived empirically in native test (precise to ~5_000)
const PURCHASE_GAS_LIMIT: u64 = 55_000 + WASM_BUMP;
const REDEEM_GAS_LIMIT: u64 = 70_000 + WASM_BUMP;
const SWAP_GAS_LIMIT: u64 = 60_000 + WASM_BUMP;

// Additional needed for wasm execution
// (may not be as precise as per-request limits found above)
const WASM_BUMP: u64 = if cfg!(target_family = "wasm") {
    75_000
} else {
    0
};

const REQ_GAS_MAX: u64 = REDEEM_GAS_LIMIT; // maximum of above

// Allow about 10 requests per batch
const BATCH_GAS_HIGH_WATER: u64 = 9 * REQ_GAS_MAX;

// Recommended gas limit for `process_requests()`
//   (some overhead plus enough for ~10 requests)
pub const PROCESS_REQUESTS_GAS: u64 = 10_000 + (10 * REQ_GAS_MAX);

/// State for the pair contract
#[storage]
pub struct SwapV2Driver {
    // Configuration
    cfg: Value<Cfg>,

    // Requests (can be enqueued concurrently)
    requests: RCQ<Request>,
}

#[contract(throws(ERC20Error, ISwapV2PairError))]
impl SwapV2Driver {
    // Must be called exactly once before any other methods
    pub fn initialize(&mut self, swap_pair: &Address) {
        if self.cfg.try_get().is_some() {
            panic!("Already initialized.");
        }

        let cfg = Cfg {
            swap_pair: *swap_pair,
        };

        self.cfg.set(&cfg);
    }

    pub fn request_purchase(
        &mut self,
        purchaser: &ContractAddress,
        amounts: Amounts,
        recipient: &Address,
    ) {
        self.requests
            .insert(&Request::purchase(purchaser, amounts, recipient));
    }

    pub fn request_redeem(&mut self, redeemer: &ContractAddress) {
        self.requests.insert(&Request::redeem(redeemer));
    }

    pub fn request_swap(&mut self, trader: &ContractAddress, amounts_out: Amounts) {
        self.requests.insert(&Request::swap(trader, amounts_out));
    }

    pub fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        let mut n_processed = 0;
        let mut n_failed = 0;
        let mut batch_gas_consumed_max = 0u64;

        while let Some(req) = self.requests.try_consume() {
            if batch_gas_consumed_max > BATCH_GAS_HIGH_WATER {
                break;
            }
            match req {
                Request::Purchase(ref req) => {
                    cfg.pair()
                        .with_gas_limit(PURCHASE_GAS_LIMIT)
                        .try_handle_purchase(&req.purchaser, req.amounts, &req.recipient)
                        .unwrap_or_else(|e| {
                            operation_failed("Purchase", &e);
                            n_failed += 1;
                        });
                    batch_gas_consumed_max += PURCHASE_GAS_LIMIT;
                }
                Request::Redeem(ref req) => {
                    cfg.pair()
                        .with_gas_limit(REDEEM_GAS_LIMIT)
                        .try_handle_redeem(&req.redeemer)
                        .unwrap_or_else(|e| {
                            operation_failed("Redeem", &e);
                            n_failed += 1;
                        });
                    batch_gas_consumed_max += REDEEM_GAS_LIMIT;
                }
                Request::Swap(ref req) => {
                    cfg.pair()
                        .with_gas_limit(SWAP_GAS_LIMIT)
                        .try_handle_swap(&req.trader, req.amounts_out)
                        .unwrap_or_else(|e| {
                            operation_failed("Swap", &e);
                            n_failed += 1;
                        });
                    batch_gas_consumed_max += SWAP_GAS_LIMIT;
                }
            }
            n_processed += 1;
        }

        (n_processed, n_failed)
    }
}

fn operation_failed(name: &str, e: &ISwapV2PairClientError) {
    #[cfg(feature = "dev")]
    println!("!! {name} failed: {e:?}");

    #[cfg(not(feature = "dev"))]
    {
        let _ = name;
        let _ = e;
    }

    // TODO: emit event
}
