//! What ordering a batch by CLVR costs on a node, by batch size.
//!
//! A real crank can be measured only as far as a test can fund one (see `swap-router`'s
//! `calibration` test), which is a handful of requests. The ordering's own cost grows with the
//! batch, so this runs the same `Clvr` over synthetic batches of any size, handling nothing, and
//! reports what it spent. Call it with `simulateInvocation`, whose gas is the node's.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use batch_driver::Sequencer;
use swap_clvr_driver::clvr::Clvr;
use swap_if::{Amount, SwapRequest};
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::*;

thruput_sdk::declare_mock_contract!();

/// What ordering one batch cost: building the sequencer, the dearest step, and all the steps.
#[contract_type]
pub struct Cost {
    pub setup: u64,
    pub dearest_step: u64,
    pub steps: u64,
}

pub struct ClvrBench;

#[contract]
impl ClvrBench {
    /// Order a batch of `n` trades against a pool of `depth` in each token, as if every one
    /// succeeded. With `adversarial`, every trade goes the same way, largest first: the order that
    /// costs building the runs the most.
    pub fn order(n: u32, depth: Amount, adversarial: bool) -> Cost {
        let batch = batch(n, depth, adversarial);

        let before = gas_remaining();
        let mut clvr = Clvr::new(&batch, || [depth, depth]);
        let setup = before.saturating_sub(gas_remaining());

        let mut dearest_step = 0;
        let mut steps = 0;
        for _ in 0..n {
            let before = gas_remaining();
            core::hint::black_box(clvr.next());
            clvr.handled(true);
            let step = before.saturating_sub(gas_remaining());

            dearest_step = dearest_step.max(step);
            steps += step;
        }

        Cost {
            setup,
            dearest_step,
            steps,
        }
    }
}

// A deterministic batch: both directions and both kinds, sizes spread over orders of magnitude.
fn batch(n: u32, depth: Amount, adversarial: bool) -> Vec<SwapRequest> {
    let me = ContractAddress::new([1; 32]);
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };

    (0..n)
        .map(|i| {
            if adversarial {
                let size = depth / 1_000 * Amount::from(n - i);
                return SwapRequest::swap_exact_in(&me, size, 0, 0, &me);
            }

            let r = next();
            let in_index = (r & 1) as u32;
            let size = (depth / 100 >> (r >> 1) % 16).max(1) * (1 + Amount::from((r >> 8) % 9));
            if r >> 16 & 1 == 0 {
                SwapRequest::swap_exact_in(&me, size, 0, in_index, &me)
            } else {
                SwapRequest::swap_exact_out(&me, size, Amount::MAX, in_index, &me)
            }
        })
        .collect()
}
