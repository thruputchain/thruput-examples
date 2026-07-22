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
            let time_elapsed: u128 = time_elapsed.into();
            self.cumulative_prices[0] += ((r1 / r0) * time_elapsed).into();
            self.cumulative_prices[1] += ((r0 / r1) * time_elapsed).into();
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
