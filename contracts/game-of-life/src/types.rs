use sdk::*;

pub type RequestId = SHA256Hash;

#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct WorldState {
    pub generation: u64,
    pub active_bank: u32,
    pub seed: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
    pub max_queue_len: u32,
}

#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct WorldMetadata {
    pub width: u32,
    pub height: u32,
    pub generation: u64,
    pub seed: u64,
    pub population: u64,
    pub state_digest: SHA256Hash,
    pub chunk_bytes: u32,
    pub chunks_per_row: u32,
    pub max_queue_len: u32,
}

#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct TickRequest {
    pub request_id: RequestId,
    pub requested_by: ContractAddress,
}

#[contract_type]
#[cfg_attr(feature = "dev", derive(Debug, PartialEq, Eq))]
pub struct TickResult {
    pub request_id: RequestId,
    pub requested_by: ContractAddress,
    pub metadata: WorldMetadata,
}

#[contract_exception]
pub enum GameOfLifeError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    CoordinateOutOfBounds = 3,
    ChunkOutOfBounds = 4,
    GenerationOverflow = 5,
    InvalidStoredState = 6,
    InvalidQueueCapacity = 7,
}

#[derive(Event, Clone, Debug)]
pub struct WorldInitialized {
    pub seed: u64,
    pub max_queue_len: u32,
    pub population: u64,
    pub state_digest: SHA256Hash,
}

#[derive(Event, Clone, Debug)]
pub struct TickRequested<'a> {
    #[topic]
    pub request_id: &'a RequestId,
    #[topic]
    pub requested_by: &'a ContractAddress,
}

#[derive(Event, Clone, Debug)]
pub struct GenerationAdvanced<'a> {
    #[topic]
    pub request_id: &'a RequestId,
    pub generation: u64,
    pub requested_by: &'a ContractAddress,
    pub population: u64,
    pub state_digest: SHA256Hash,
}
