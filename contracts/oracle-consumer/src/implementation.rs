use thruput_sdk::*;

use crate::oracle::{OracleClient, PriceUpdate};

#[contract_exception]
pub enum ConsumerError {
    FutureObservation = 1,
    StaleObservation = 2,
    InvalidPrecision = 3,
    Overflow = 4,
    InvalidObservation = 5,
}

/// Stateless consumer. The caller selects a trusted oracle and feed explicitly.
pub struct OracleConsumer;

#[contract(throws = ConsumerError)]
impl OracleConsumer {
    /// Fetch a price, preserving its precision, round, and source timestamp.
    pub fn latest_price(
        oracle: &ContractAddress,
        feed_id: u32,
        max_age_seconds: u64,
    ) -> PriceUpdate {
        let observation = OracleClient::new(oracle).get_price(feed_id).observation;
        ensure(
            observation.feed_id == feed_id
                && observation.price > 0
                && observation.timestamp > 0
                && observation.round > 0,
            ConsumerError::InvalidObservation,
        );
        ensure(observation.decimals <= 18, ConsumerError::InvalidPrecision);
        let now = get_block_timepoint().into_inner() / 1_000_000_000;
        // Use source time, not the time at which the relay published the price.
        let age = now
            .checked_sub(observation.timestamp)
            .unwrap_or_else(|| throw(ConsumerError::FutureObservation));
        ensure(age <= max_age_seconds, ConsumerError::StaleObservation);
        observation
    }

    /// Return floor(amount * price / 10^amount_decimals) in feed precision.
    pub fn value(
        oracle: &ContractAddress,
        feed_id: u32,
        amount: u128,
        amount_decimals: u32,
        max_age_seconds: u64,
    ) -> u128 {
        ensure(amount_decimals <= 18, ConsumerError::InvalidPrecision);
        let observation = Self::latest_price(oracle, feed_id, max_age_seconds);
        // A 256-bit intermediate avoids rejecting a product whose quotient fits.
        checked_mul_div_u128(
            amount,
            observation.price as u128,
            10_u128.pow(amount_decimals),
        )
        .unwrap_or_else(|| throw(ConsumerError::Overflow))
    }
}
