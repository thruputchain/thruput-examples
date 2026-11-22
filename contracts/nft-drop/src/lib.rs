//! One NFT drop: an ERC721 collection whose public mints land concurrently.

#![cfg_attr(not(feature = "dev"), no_std)]

extern crate alloc;

thruput_sdk::declare_mock_contract!();

mod implementation;

pub use implementation::*;
pub use thruput_erc165_if::{ERC165, ERC165Client};
pub use thruput_erc721_if::{
    ERC721, ERC721Client, ERC721Error, ERC721Metadata, ERC721MetadataClient, Name, Symbol, TokenId,
    TokenMetadata,
};
