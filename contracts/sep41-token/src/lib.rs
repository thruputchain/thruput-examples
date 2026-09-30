//! A SEP-41 token.
//!
//! [`Token`] implements the [SEP-41] interface from `sep41-token-if`, the way
//! the Soroban token example does, failing with its own [`TokenError`]s. It
//! adds a [`TokenAdmin`](TokenAdminClient) interface with the functions SEP-41
//! leaves to each token: `initialize`, and the administrator's `mint` and
//! `set_admin`, which match the Stellar Asset Contract's.
//!
//! [SEP-41]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md

#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

mod implementation;

pub use implementation::{SetAdmin, Token, TokenAdminClient, TokenAdminError, TokenError};
