//! Pure, deterministic snapshot derivation for the 100-million-cell Life world.

mod schema;
mod snapshot;

pub use schema::{
    EventKind, EvidenceKind, IndexerState, LatestPointer, LifeManifest, LifeProvenance, LifeStatus,
    Progress, ProgressUnit, PublishedIdentity, Retry, SnapshotIdentity, Verification,
};
pub use snapshot::{
    Artifact, ArtifactPath, ChunkResponse, Snapshot, SnapshotMetadata, TileCoordinate,
    build_snapshot, reconstruct_canonical_world,
};

pub const WORLD_WIDTH: u32 = 10_000;
pub const WORLD_HEIGHT: u32 = 10_000;
pub const CELL_COUNT: u64 = 100_000_000;
pub const ROW_BYTES: usize = 1_250;
pub const CHUNK_BYTES: usize = 1_000;
pub const TAIL_BYTES: usize = 250;
pub const CHUNKS_PER_ROW: u32 = 2;
pub const CHUNK_COUNT: usize = 20_000;
pub const CANONICAL_BYTES: usize = 12_500_000;
pub const TILE_SIZE: u32 = 256;
pub const MAX_ZOOM: u8 = 6;
pub const CELL_TILE_BYTES: usize = 8_192;
pub const DENSITY_TILE_BYTES: usize = 131_072;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("unsupported metadata field {field}: expected {expected}, got {actual}")]
    UnsupportedMetadata {
        field: &'static str,
        expected: u32,
        actual: u32,
    },
    #[error("expected {expected} chunks, got {actual}")]
    ChunkCount { expected: usize, actual: usize },
    #[error("chunk coordinate ({row}, {part}) is out of range")]
    ChunkCoordinate { row: u32, part: u32 },
    #[error("duplicate chunk coordinate ({row}, {part})")]
    DuplicateChunk { row: u32, part: u32 },
    #[error("chunk ({row}, {part}) has length {actual}; expected {expected}")]
    ChunkLength {
        row: u32,
        part: u32,
        actual: usize,
        expected: &'static str,
    },
    #[error("canonical byte length mismatch: expected {expected}, got {actual}")]
    CanonicalLength { expected: usize, actual: usize },
    #[error("population mismatch: expected {expected}, got {actual}")]
    Population { expected: u64, actual: u64 },
    #[error("state digest mismatch: expected {expected}, got {actual}")]
    Digest { expected: String, actual: String },
    #[error("tile coordinate ({z}, {x}, {y}) is out of range")]
    TileCoordinate { z: u8, x: u32, y: u32 },
    #[error("tile inventory mismatch at index {index}: expected {expected}, got {actual}")]
    TileInventory {
        index: usize,
        expected: String,
        actual: String,
    },
    #[error("tile {z}/{x}/{y} has length {actual}, expected {expected}")]
    TileLength {
        z: u8,
        x: u32,
        y: u32,
        expected: usize,
        actual: usize,
    },
    #[error("tile {z}/{x}/{y} has nonzero edge padding")]
    EdgePadding { z: u8, x: u32, y: u32 },
    #[error("density value {value} at level {z} exceeds {maximum}")]
    DensityRange { z: u8, value: u16, maximum: u32 },
    #[error("level {z} population mismatch: expected {expected}, got {actual}")]
    LevelPopulation { z: u8, expected: u64, actual: u64 },
    #[error("density parent sum mismatch at level {z}, texel ({x}, {y})")]
    ParentSum { z: u8, x: u32, y: u32 },
    #[error("level-six tile roundtrip differs from canonical bytes")]
    TileRoundtrip,
    #[error("invalid {field}: {reason}")]
    Schema {
        field: &'static str,
        reason: &'static str,
    },
    #[error("JSON is malformed or does not match the schema: {0}")]
    Json(String),
}

pub type Result<T> = core::result::Result<T, Error>;
