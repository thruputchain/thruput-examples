#![cfg_attr(not(feature = "dev"), no_std)]

use sdk::storage::{Bytestring, Map};
use sdk::*;

sdk::declare_mock_contract!();

const CHUNK_BYTES: usize = 1_000;
const TAIL_BYTES: usize = 250;
const CHUNKS_PER_ROW: u32 = 2;
const MAX_CHUNKS: u32 = 20_000;

#[sdk::storage]
pub struct LifeStorageAdmission {
    chunks: Map<u32, Bytestring>,
    destination: Map<u32, Bytestring>,
}

#[contract]
impl LifeStorageAdmission {
    pub fn write_chunks(&mut self, chunk_count: u32) -> u32 {
        assert!(chunk_count <= MAX_CHUNKS);
        let full = [0xA5; CHUNK_BYTES];
        let tail = [0x5A; TAIL_BYTES];

        for key in 0..chunk_count {
            if key % CHUNKS_PER_ROW == 0 {
                self.chunks.at_mut(&key).set(&full);
            } else {
                self.chunks.at_mut(&key).set(&tail);
            }
        }
        chunk_count
    }

    pub fn copy_world(&mut self) -> u32 {
        let mut previous = [0u8; CHUNK_BYTES + TAIL_BYTES];
        let mut current = [0u8; CHUNK_BYTES + TAIL_BYTES];
        let mut next = [0u8; CHUNK_BYTES + TAIL_BYTES];
        load_row(&self.chunks, 9_999, &mut previous);
        load_row(&self.chunks, 0, &mut current);
        load_row(&self.chunks, 1, &mut next);

        for row in 0..10_000u32 {
            let key = row * CHUNKS_PER_ROW;
            self.destination.at_mut(&key).set(&current[..CHUNK_BYTES]);
            self.destination
                .at_mut(&(key + 1))
                .set(&current[CHUNK_BYTES..]);
            if row + 1 < 10_000 {
                core::mem::swap(&mut previous, &mut current);
                core::mem::swap(&mut current, &mut next);
                load_row(&self.chunks, (row + 2) % 10_000, &mut next);
            }
        }
        MAX_CHUNKS
    }
}

fn load_row(chunks: &Map<u32, Bytestring>, row: u32, output: &mut [u8; 1_250]) {
    let key = row * CHUNKS_PER_ROW;
    let full: [u8; CHUNK_BYTES] = chunks.at(&key).get_sized();
    let tail: [u8; TAIL_BYTES] = chunks.at(&(key + 1)).get_sized();
    output[..CHUNK_BYTES].copy_from_slice(&full);
    output[CHUNK_BYTES..].copy_from_slice(&tail);
}
