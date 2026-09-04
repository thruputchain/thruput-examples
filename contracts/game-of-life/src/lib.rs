#![cfg_attr(not(feature = "dev"), no_std)]

sdk::declare_mock_contract!();

mod contract;
mod types;

pub use contract::{
    CELL_COUNT, CHUNK_BYTES, CHUNKS_PER_BANK, CHUNKS_PER_ROW, ROW_BYTES, TAIL_BYTES, WORLD_HEIGHT,
    WORLD_WIDTH,
};
pub use contract::{GameOfLife, GameOfLifeClient};
pub use game_of_life_core::{digest, kernel, prng};
pub use types::*;
