use crate::events::*;
use crate::interface::*;
use crate::u256::U256;
use sdk::*;

const BALANCE_MAX: u128 = i128::MAX as u128;

// The state value
//
// No concurrent sets allowed.
//
#[contract_type]
#[derive(Copy, Clone, Debug)]
pub struct Reserves {
    // The last recorded reserve balances.
    pub balances: [u128; 2],

    // Cumulative prices associated with the balances above.
    pub cumulative_prices: [U256; 2],

    // The block in which the reserve balances were last recorded.
    pub block_timestamp: u32,
}

impl Reserves {
    pub const fn new() -> Self {
        Self {
            balances: [0; 2],
            cumulative_prices: [U256::zero(), U256::zero()],
            block_timestamp: 0,
        }
    }

    pub const fn balances(&self) -> [u128; 2] {
        self.balances
    }

    pub const fn block_timestamp(&self) -> u32 {
        self.block_timestamp
    }

    // Update the reserve balances, also updating the cumulative prices and
    // block timestamp.
    pub fn update(&mut self, balances: Amounts) {
        // If this fails, `skim()` may be used to extract the overflow
        ensure(
            balances[0] <= BALANCE_MAX && balances[1] <= BALANCE_MAX,
            SwapPairError::Overflow,
        );

        // We intentionally truncate here, desiring the timestamp mod 2^32
        let current_block = get_block_timestamp() as u32;

        // Wrapping yields the right elapsed time if this method is
        // run at least once every ~139 years.
        let time_elapsed = current_block.wrapping_sub(self.block_timestamp);

        // Increment the cumulative prices
        let [r0, r1] = self.balances();
        if time_elapsed > 0 && r0 != 0 && r1 != 0 {
            // Wrapping of the accumulation is desired
            let (c0, _) =
                self.cumulative_prices[0].overflowing_add(uq112x112_div_mul(r1, r0, time_elapsed));
            let (c1, _) =
                self.cumulative_prices[1].overflowing_add(uq112x112_div_mul(r0, r1, time_elapsed));
            self.cumulative_prices[0] = c0;
            self.cumulative_prices[1] = c1;
        }

        // Record the new balances
        self.balances = balances;

        self.block_timestamp = current_block;

        log_event(&SyncEvent::new(balances));
    }
}

fn get_block_timestamp() -> u64 {
    get_block_height().into_inner().try_into().unwrap()
}

// Compute `((a * 2^112) / b) * p` — a UQ112x112 (112 fractional bits) price
// contribution, matching UniswapV2's price accumulator.
//
// The `<< 112` preserves the fractional part of the `a / b` ratio that a plain
// integer division would discard. `a << 112` cannot overflow (`a` is capped at
// `BALANCE_MAX < 2^127`, so the shift yields at most `2^239`), but the final
// multiply by the elapsed time is allowed to wrap, exactly as UniswapV2
// intends: oracle consumers difference the accumulator, so wrap-around cancels.
fn uq112x112_div_mul(a: u128, b: u128, p: u32) -> U256 {
    let a = U256::from(a);
    let b = U256::from(b);
    let (scaled, _overflow) = ((a << 112) / b).overflowing_mul(U256::from(p));
    scaled
}
