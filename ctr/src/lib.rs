#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

mod implementation;

pub use implementation::Counter;
pub use implementation::CounterClient;
pub use implementation::CounterClientError;
