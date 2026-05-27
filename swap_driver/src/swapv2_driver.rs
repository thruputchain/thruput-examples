//! A contract implementing ISwapV2Driver

#![allow(clippy::result_large_err)]

use crate::cfg::*;
use crate::request::*;
use sdk::storage::*;
use sdk::*;
use swap::*;

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

    pub fn request_purchase(&mut self, purchaser: &ContractAddress, amounts: Amounts, recipient: &Address) {
        self.requests.insert(&Request::purchase(purchaser, amounts, recipient));
    }

    pub fn request_redeem(&mut self, redeemer: &ContractAddress) {
        self.requests.insert(&Request::redeem(redeemer));
    }

    pub fn request_swap(
        &mut self,
        trader: &ContractAddress,
        amounts_out: Amounts,
    ) {
        self.requests.insert(&Request::swap(trader, amounts_out));
    }

    pub fn process_requests(&mut self) -> (u32, u32) {
        let cfg = self.cfg.get();

        let mut n_processed = 0;
        let mut n_failed = 0;

        const BATCH_MAX: u32 = 10;

        // Empirically-derived limits (precise to ~5_000)
        const PURCHASE_GAS_LIMIT: u64 = 55_000;
        const REDEEM_GAS_LIMIT: u64 = 70_000;
        const SWAP_GAS_LIMIT: u64 = 60_000;

        while let Some(req) = self.requests.try_consume() {
            if n_processed >= BATCH_MAX {
                break;
            }
            match req {
                Request::Purchase(ref req) => cfg
                    .pair()
                    .with_gas_limit(PURCHASE_GAS_LIMIT)
                    .try_handle_purchase(&req.purchaser, req.amounts, &req.recipient)
                    .unwrap_or_else(|e| {
                        operation_failed("Purchase", &e);
                        n_failed += 1;
                    }),
                Request::Redeem(ref req) => cfg
                    .pair()
                    .with_gas_limit(REDEEM_GAS_LIMIT)
                    .try_handle_redeem(&req.redeemer)
                    .unwrap_or_else(|e| {
                        operation_failed("Redeem", &e);
                        n_failed += 1;
                    }),
                Request::Swap(ref req) => cfg
                    .pair()
                    .with_gas_limit(SWAP_GAS_LIMIT)
                    .try_handle_swap(&req.trader, req.amounts_out)
                    .unwrap_or_else(|e| {
                        operation_failed("Swap", &e);
                        n_failed += 1;
                    }),
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
