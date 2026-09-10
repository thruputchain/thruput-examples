use crate::types::*;
use game_of_life_core::digest::WorldDigest;
use game_of_life_core::kernel::compute_next_row;
use game_of_life_core::prng::SplitMix64;
use queue_slots::Slots;
use sdk::storage::{Bytestring, Map, NNInt, Node, RCQ, Value};
use sdk::*;

pub const WORLD_WIDTH: u32 = 10_000;
pub const WORLD_HEIGHT: u32 = 10_000;
pub const CELL_COUNT: u64 = 100_000_000;
pub const ROW_BYTES: usize = 1_250;
pub const CHUNK_BYTES: usize = 1_000;
pub const TAIL_BYTES: usize = 250;
pub const CHUNKS_PER_ROW: u32 = 2;
pub const CHUNKS_PER_BANK: u32 = 20_000;

#[sdk::storage]
pub struct GameOfLife {
    state: Value<WorldState>,
    bank_a: Map<u32, Bytestring>,
    bank_b: Map<u32, Bytestring>,
    requests: RCQ<TickRequest>,
    request_sequence: NNInt,
    queue_slots: Node<Slots>,
}

#[contract(
    throws = GameOfLifeError,
    emits(WorldInitialized, TickRequested, GenerationAdvanced)
)]
impl GameOfLife {
    pub fn initialize(&mut self, seed: u64, max_queue_len: u32) -> WorldMetadata {
        if self.state.try_get().none_if_missing().is_some() {
            throw(GameOfLifeError::AlreadyInitialized);
        }
        if max_queue_len == 0 {
            throw(GameOfLifeError::InvalidQueueCapacity);
        }

        let mut prng = SplitMix64::new(seed);
        let mut digest = WorldDigest::new(WORLD_WIDTH, WORLD_HEIGHT, 0);
        let mut population = 0u64;
        let mut full_chunk = [0u8; CHUNK_BYTES];
        let mut tail_chunk = [0u8; TAIL_BYTES];

        for row in 0..WORLD_HEIGHT {
            let first_key = row * CHUNKS_PER_ROW;
            prng.fill_bytes(&mut full_chunk);
            population += count_population(&full_chunk);
            self.bank_a.at_mut(&first_key).set(&full_chunk);
            digest.update(first_key, &full_chunk);

            let tail_key = first_key + 1;
            prng.fill_bytes(&mut tail_chunk);
            population += count_population(&tail_chunk);
            self.bank_a.at_mut(&tail_key).set(&tail_chunk);
            digest.update(tail_key, &tail_chunk);
        }

        let state = WorldState {
            generation: 0,
            active_bank: 0,
            seed,
            population,
            state_digest: SHA256Hash::new(digest.finish()),
            max_queue_len,
        };
        self.state.set_exclusive(&state);
        self.queue_slots.set_capacity(max_queue_len);
        log_event(&WorldInitialized {
            seed,
            max_queue_len,
            population,
            state_digest: state.state_digest,
        });
        metadata(&state)
    }

    pub fn request_tick(&mut self) -> RequestId {
        self.require_state();
        self.queue_slots.reserve();
        self.request_sequence.inc(1);
        let request_id = (get_source_transaction_hash(), self.request_sequence.get()).hash();
        let requested_by = get_caller();
        self.requests.insert(&TickRequest {
            request_id,
            requested_by,
        });
        log_event(&TickRequested {
            request_id: &request_id,
            requested_by: &requested_by,
        });
        request_id
    }

    pub fn process_next_tick(&mut self) -> Option<TickResult> {
        let state = self.require_state();
        let request = self.requests.try_consume().none_if_missing()?;
        let next_generation = state
            .generation
            .checked_add(1)
            .unwrap_or_else(|| throw(GameOfLifeError::GenerationOverflow));
        let inactive_bank = match state.active_bank {
            0 => 1,
            1 => 0,
            _ => throw(GameOfLifeError::InvalidStoredState),
        };

        let mut previous = [0u8; ROW_BYTES];
        let mut current = [0u8; ROW_BYTES];
        let mut next = [0u8; ROW_BYTES];
        let mut output = [0u8; ROW_BYTES];
        self.read_row(state.active_bank, WORLD_HEIGHT - 1, &mut previous);
        self.read_row(state.active_bank, 0, &mut current);
        self.read_row(state.active_bank, 1, &mut next);

        let mut population = 0u64;
        let mut digest = WorldDigest::new(WORLD_WIDTH, WORLD_HEIGHT, next_generation);
        for row in 0..WORLD_HEIGHT {
            population += u64::from(compute_next_row(&previous, &current, &next, &mut output));
            self.write_row(inactive_bank, row, &output, &mut digest);

            if row + 1 < WORLD_HEIGHT {
                core::mem::swap(&mut previous, &mut current);
                core::mem::swap(&mut current, &mut next);
                self.read_row(state.active_bank, (row + 2) % WORLD_HEIGHT, &mut next);
            }
        }

        let next_state = WorldState {
            generation: next_generation,
            active_bank: inactive_bank,
            seed: state.seed,
            population,
            state_digest: SHA256Hash::new(digest.finish()),
            max_queue_len: state.max_queue_len,
        };
        self.state.set_exclusive(&next_state);
        self.queue_slots.release(1);
        log_event(&GenerationAdvanced {
            request_id: &request.request_id,
            generation: next_generation,
            requested_by: &request.requested_by,
            population,
            state_digest: next_state.state_digest,
        });
        Some(TickResult {
            request_id: request.request_id,
            requested_by: request.requested_by,
            metadata: metadata(&next_state),
        })
    }

    pub fn get_metadata(&self) -> WorldMetadata {
        metadata(&self.require_state())
    }

    pub fn get_chunk(&self, row: u32, part: u32) -> [u8; CHUNK_BYTES] {
        if row >= WORLD_HEIGHT || part >= CHUNKS_PER_ROW {
            throw(GameOfLifeError::ChunkOutOfBounds);
        }
        let state = self.require_state();
        let key = row * CHUNKS_PER_ROW + part;
        let mut output = [0u8; CHUNK_BYTES];
        if part == 0 {
            output = self.bank(state.active_bank).at(&key).get_sized();
        } else {
            let tail: [u8; TAIL_BYTES] = self.bank(state.active_bank).at(&key).get_sized();
            output[..TAIL_BYTES].copy_from_slice(&tail);
        }
        output
    }

    pub fn get_cell(&self, x: u32, y: u32) -> bool {
        if x >= WORLD_WIDTH || y >= WORLD_HEIGHT {
            throw(GameOfLifeError::CoordinateOutOfBounds);
        }
        let state = self.require_state();
        let byte_in_row = x as usize / 8;
        let part = u32::from(byte_in_row >= CHUNK_BYTES);
        let offset = byte_in_row % CHUNK_BYTES;
        let key = y * CHUNKS_PER_ROW + part;
        let byte = if part == 0 {
            let chunk: [u8; CHUNK_BYTES] = self.bank(state.active_bank).at(&key).get_sized();
            chunk[offset]
        } else {
            let chunk: [u8; TAIL_BYTES] = self.bank(state.active_bank).at(&key).get_sized();
            chunk[offset]
        };
        ((byte >> (x % 8)) & 1) != 0
    }
}

impl GameOfLife {
    fn require_state(&self) -> WorldState {
        self.state
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(GameOfLifeError::NotInitialized))
    }

    fn bank(&self, bank: u32) -> &Map<u32, Bytestring> {
        match bank {
            0 => &self.bank_a,
            1 => &self.bank_b,
            _ => throw(GameOfLifeError::InvalidStoredState),
        }
    }

    fn read_row(&self, bank: u32, row: u32, output: &mut [u8; ROW_BYTES]) {
        let key = row * CHUNKS_PER_ROW;
        let first: [u8; CHUNK_BYTES] = self.bank(bank).at(&key).get_sized();
        let tail: [u8; TAIL_BYTES] = self.bank(bank).at(&(key + 1)).get_sized();
        output[..CHUNK_BYTES].copy_from_slice(&first);
        output[CHUNK_BYTES..].copy_from_slice(&tail);
    }

    fn write_row(
        &mut self,
        bank: u32,
        row: u32,
        bytes: &[u8; ROW_BYTES],
        digest: &mut WorldDigest,
    ) {
        let key = row * CHUNKS_PER_ROW;
        let (first, tail) = bytes.split_at(CHUNK_BYTES);
        match bank {
            0 => {
                self.bank_a.at_mut(&key).set(first);
                self.bank_a.at_mut(&(key + 1)).set(tail);
            }
            1 => {
                self.bank_b.at_mut(&key).set(first);
                self.bank_b.at_mut(&(key + 1)).set(tail);
            }
            _ => throw(GameOfLifeError::InvalidStoredState),
        }
        digest.update(key, first);
        digest.update(key + 1, tail);
    }
}

fn count_population(bytes: &[u8]) -> u64 {
    bytes.iter().map(|byte| u64::from(byte.count_ones())).sum()
}

fn metadata(state: &WorldState) -> WorldMetadata {
    WorldMetadata {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        generation: state.generation,
        seed: state.seed,
        population: state.population,
        state_digest: state.state_digest,
        chunk_bytes: CHUNK_BYTES as u32,
        chunks_per_row: CHUNKS_PER_ROW,
        max_queue_len: state.max_queue_len,
    }
}
