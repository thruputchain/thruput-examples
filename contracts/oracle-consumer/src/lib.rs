#![cfg_attr(not(feature = "dev"), no_std)]

thruput_sdk::declare_mock_contract!();

mod implementation;
pub mod oracle;

pub use implementation::{ConsumerError, OracleConsumer, OracleConsumerClient};
