use game_of_life_core::digest::WorldDigest;

use crate::schema::{LifeManifest, LifeProvenance, SnapshotIdentity, compact_json};
use crate::{
    CANONICAL_BYTES, CELL_TILE_BYTES, CHUNK_BYTES, CHUNK_COUNT, CHUNKS_PER_ROW, DENSITY_TILE_BYTES,
    Error, MAX_ZOOM, ROW_BYTES, Result, TAIL_BYTES, TILE_SIZE, WORLD_HEIGHT, WORLD_WIDTH,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotMetadata {
    pub width: u32,
    pub height: u32,
    pub generation: u64,
    pub seed: u64,
    pub population: u64,
    pub state_digest: [u8; 32],
    pub chunk_bytes: u32,
    pub chunks_per_row: u32,
    pub max_queue_len: u32,
}

impl SnapshotMetadata {
    pub fn validate(&self) -> Result<()> {
        for (field, expected, actual) in [
            ("width", WORLD_WIDTH, self.width),
            ("height", WORLD_HEIGHT, self.height),
            ("chunk_bytes", CHUNK_BYTES as u32, self.chunk_bytes),
            ("chunks_per_row", CHUNKS_PER_ROW, self.chunks_per_row),
        ] {
            if actual != expected {
                return Err(Error::UnsupportedMetadata {
                    field,
                    expected,
                    actual,
                });
            }
        }
        if self.max_queue_len == 0 {
            return Err(Error::UnsupportedMetadata {
                field: "max_queue_len",
                expected: 1,
                actual: 0,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkResponse {
    pub row: u32,
    pub part: u32,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TileCoordinate {
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

impl TileCoordinate {
    pub fn new(z: u8, x: u32, y: u32) -> Result<Self> {
        let count = tile_count_axis(z).ok_or(Error::TileCoordinate { z, x, y })?;
        if x >= count || y >= count {
            return Err(Error::TileCoordinate { z, x, y });
        }
        Ok(Self { z, x, y })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactPath(String);

impl ArtifactPath {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn tile(coordinate: TileCoordinate) -> Self {
        Self(format!(
            "tiles/{}/{}/{}.bin",
            coordinate.z, coordinate.x, coordinate.y
        ))
    }

    fn provenance() -> Self {
        Self("provenance.json".into())
    }

    fn manifest() -> Self {
        Self("manifest.json".into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub path: ArtifactPath,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub manifest: LifeManifest,
    pub provenance: LifeProvenance,
    pub artifacts: Vec<Artifact>,
}

pub fn reconstruct_canonical_world(
    metadata: &SnapshotMetadata,
    chunks: Vec<ChunkResponse>,
) -> Result<Vec<u8>> {
    metadata.validate()?;
    if chunks.len() != CHUNK_COUNT {
        return Err(Error::ChunkCount {
            expected: CHUNK_COUNT,
            actual: chunks.len(),
        });
    }

    let mut ordered: Vec<Option<Vec<u8>>> = vec![None; CHUNK_COUNT];
    for chunk in chunks {
        if chunk.row >= WORLD_HEIGHT || chunk.part >= CHUNKS_PER_ROW {
            return Err(Error::ChunkCoordinate {
                row: chunk.row,
                part: chunk.part,
            });
        }
        let valid_length = match chunk.part {
            0 => chunk.bytes.len() == CHUNK_BYTES,
            1 => matches!(chunk.bytes.len(), TAIL_BYTES | CHUNK_BYTES),
            _ => false,
        };
        if !valid_length {
            return Err(Error::ChunkLength {
                row: chunk.row,
                part: chunk.part,
                actual: chunk.bytes.len(),
                expected: if chunk.part == 0 {
                    "exactly 1000 bytes"
                } else {
                    "exactly 250 or 1000 bytes"
                },
            });
        }
        let index = (chunk.row * CHUNKS_PER_ROW + chunk.part) as usize;
        if ordered[index].replace(chunk.bytes).is_some() {
            return Err(Error::DuplicateChunk {
                row: chunk.row,
                part: chunk.part,
            });
        }
    }

    let mut canonical = Vec::with_capacity(CANONICAL_BYTES);
    let mut digest = WorldDigest::new(WORLD_WIDTH, WORLD_HEIGHT, metadata.generation);
    let mut population = 0u64;
    for (key, chunk) in ordered.into_iter().enumerate() {
        let chunk = chunk.ok_or(Error::ChunkCount {
            expected: CHUNK_COUNT,
            actual: key,
        })?;
        let canonical_chunk = if key % CHUNKS_PER_ROW as usize == 0 {
            &chunk
        } else {
            &chunk[..TAIL_BYTES]
        };
        population += canonical_chunk
            .iter()
            .map(|byte| u64::from(byte.count_ones()))
            .sum::<u64>();
        digest.update(key as u32, canonical_chunk);
        canonical.extend_from_slice(canonical_chunk);
    }
    if canonical.len() != CANONICAL_BYTES {
        return Err(Error::CanonicalLength {
            expected: CANONICAL_BYTES,
            actual: canonical.len(),
        });
    }
    if population != metadata.population {
        return Err(Error::Population {
            expected: metadata.population,
            actual: population,
        });
    }
    let actual_digest = digest.finish();
    if actual_digest != metadata.state_digest {
        return Err(Error::Digest {
            expected: hex_digest(&metadata.state_digest),
            actual: hex_digest(&actual_digest),
        });
    }
    Ok(canonical)
}

pub fn build_snapshot(
    metadata: &SnapshotMetadata,
    network_id: String,
    contract_address: String,
    chunks: Vec<ChunkResponse>,
    provenance: LifeProvenance,
) -> Result<Snapshot> {
    let canonical = reconstruct_canonical_world(metadata, chunks)?;
    let identity = SnapshotIdentity {
        network_id,
        contract_address,
        generation: metadata.generation,
        seed: metadata.seed,
        population: metadata.population,
        state_digest: metadata.state_digest,
    };
    identity.validate()?;
    provenance.validate()?;
    if !provenance.matches(&identity) {
        return Err(Error::Schema {
            field: "provenance",
            reason: "identity does not match snapshot",
        });
    }
    let manifest = LifeManifest::new(&identity);
    manifest.validate()?;

    let (tiles, density_levels) = build_tiles(&canonical)?;
    validate_tiles(metadata, &canonical, &tiles, &density_levels)?;

    let mut artifacts = Vec::with_capacity(tiles.len() + 2);
    artifacts.extend(tiles.into_iter().map(|tile| Artifact {
        path: ArtifactPath::tile(tile.coordinate),
        bytes: tile.bytes,
    }));
    artifacts.push(Artifact {
        path: ArtifactPath::provenance(),
        bytes: compact_json(&provenance)?,
    });
    artifacts.push(Artifact {
        path: ArtifactPath::manifest(),
        bytes: compact_json(&manifest)?,
    });
    Ok(Snapshot {
        manifest,
        provenance,
        artifacts,
    })
}

#[derive(Debug)]
struct Tile {
    coordinate: TileCoordinate,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct DensityLevel {
    z: u8,
    width: u32,
    height: u32,
    values: Vec<u16>,
}

fn build_tiles(canonical: &[u8]) -> Result<(Vec<Tile>, Vec<DensityLevel>)> {
    if canonical.len() != CANONICAL_BYTES {
        return Err(Error::CanonicalLength {
            expected: CANONICAL_BYTES,
            actual: canonical.len(),
        });
    }
    let mut density_levels = Vec::with_capacity(MAX_ZOOM as usize);
    let mut child = build_level_five(canonical);
    for z in (0..5).rev() {
        let parent = aggregate_level(z, &child);
        density_levels.push(child);
        child = parent;
    }
    density_levels.push(child);
    density_levels.reverse();

    let mut tiles = Vec::with_capacity(2_139);
    for level in &density_levels {
        emit_density_tiles(level, &mut tiles)?;
    }
    emit_cell_tiles(canonical, &mut tiles)?;
    Ok((tiles, density_levels))
}

fn build_level_five(canonical: &[u8]) -> DensityLevel {
    let width = WORLD_WIDTH / 2;
    let height = WORLD_HEIGHT / 2;
    let mut values = vec![0u16; (width * height) as usize];
    for y in 0..WORLD_HEIGHT {
        let source = &canonical[y as usize * ROW_BYTES..(y as usize + 1) * ROW_BYTES];
        let destination = &mut values[(y / 2 * width) as usize..((y / 2 + 1) * width) as usize];
        for (byte_x, byte) in source.iter().copied().enumerate() {
            for pair in 0..4 {
                destination[byte_x * 4 + pair] +=
                    u16::from((byte >> (pair * 2) & 0b11).count_ones() as u8);
            }
        }
    }
    DensityLevel {
        z: 5,
        width,
        height,
        values,
    }
}

fn aggregate_level(z: u8, child: &DensityLevel) -> DensityLevel {
    let width = child.width.div_ceil(2);
    let height = child.height.div_ceil(2);
    let mut values = vec![0u16; (width * height) as usize];
    for y in 0..child.height {
        for x in 0..child.width {
            values[((y / 2) * width + x / 2) as usize] +=
                child.values[(y * child.width + x) as usize];
        }
    }
    DensityLevel {
        z,
        width,
        height,
        values,
    }
}

fn emit_density_tiles(level: &DensityLevel, output: &mut Vec<Tile>) -> Result<()> {
    let count = tile_count_axis(level.z).ok_or(Error::TileCoordinate {
        z: level.z,
        x: 0,
        y: 0,
    })?;
    for x in 0..count {
        for y in 0..count {
            let coordinate = TileCoordinate::new(level.z, x, y)?;
            let mut bytes = vec![0; DENSITY_TILE_BYTES];
            for local_y in 0..TILE_SIZE {
                let source_y = y * TILE_SIZE + local_y;
                if source_y >= level.height {
                    break;
                }
                for local_x in 0..TILE_SIZE {
                    let source_x = x * TILE_SIZE + local_x;
                    if source_x >= level.width {
                        break;
                    }
                    let value = level.values[(source_y * level.width + source_x) as usize];
                    let offset = ((local_y * TILE_SIZE + local_x) * 2) as usize;
                    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
                }
            }
            output.push(Tile { coordinate, bytes });
        }
    }
    Ok(())
}

fn emit_cell_tiles(canonical: &[u8], output: &mut Vec<Tile>) -> Result<()> {
    let count = tile_count_axis(MAX_ZOOM).ok_or(Error::TileCoordinate {
        z: MAX_ZOOM,
        x: 0,
        y: 0,
    })?;
    for x in 0..count {
        for y in 0..count {
            let coordinate = TileCoordinate::new(MAX_ZOOM, x, y)?;
            let mut bytes = vec![0; CELL_TILE_BYTES];
            let valid_bytes =
                ((WORLD_WIDTH.saturating_sub(x * TILE_SIZE)).min(TILE_SIZE) / 8) as usize;
            for local_y in 0..TILE_SIZE {
                let source_y = y * TILE_SIZE + local_y;
                if source_y >= WORLD_HEIGHT {
                    break;
                }
                let source_x = (x * TILE_SIZE / 8) as usize;
                let source_offset = source_y as usize * ROW_BYTES + source_x;
                let destination_offset = local_y as usize * 32;
                bytes[destination_offset..destination_offset + valid_bytes]
                    .copy_from_slice(&canonical[source_offset..source_offset + valid_bytes]);
            }
            output.push(Tile { coordinate, bytes });
        }
    }
    Ok(())
}

fn validate_tiles(
    metadata: &SnapshotMetadata,
    canonical: &[u8],
    tiles: &[Tile],
    levels: &[DensityLevel],
) -> Result<()> {
    let expected_coordinates = (0..=MAX_ZOOM).flat_map(|z| {
        let count = tile_count_axis(z).unwrap_or(0);
        (0..count).flat_map(move |x| (0..count).map(move |y| TileCoordinate { z, x, y }))
    });
    let mut expected_count = 0;
    for (index, expected_coordinate) in expected_coordinates.enumerate() {
        expected_count = index + 1;
        let Some(tile) = tiles.get(index) else {
            return Err(Error::TileInventory {
                index,
                expected: coordinate_string(expected_coordinate),
                actual: "missing".into(),
            });
        };
        if tile.coordinate != expected_coordinate {
            return Err(Error::TileInventory {
                index,
                expected: coordinate_string(expected_coordinate),
                actual: coordinate_string(tile.coordinate),
            });
        }
        TileCoordinate::new(tile.coordinate.z, tile.coordinate.x, tile.coordinate.y)?;
        let expected = if tile.coordinate.z == MAX_ZOOM {
            CELL_TILE_BYTES
        } else {
            DENSITY_TILE_BYTES
        };
        if tile.bytes.len() != expected {
            return Err(Error::TileLength {
                z: tile.coordinate.z,
                x: tile.coordinate.x,
                y: tile.coordinate.y,
                expected,
                actual: tile.bytes.len(),
            });
        }
        validate_edge_padding(tile)?;
    }
    if tiles.len() != expected_count {
        return Err(Error::TileInventory {
            index: expected_count,
            expected: "end of inventory".into(),
            actual: coordinate_string(tiles[expected_count].coordinate),
        });
    }

    for level in levels {
        let cells_per_texel = 1u32 << (MAX_ZOOM - level.z);
        let mut population = 0u64;
        for (index, value) in level.values.iter().enumerate() {
            let x = index as u32 % level.width;
            let y = index as u32 / level.width;
            let covered_width = WORLD_WIDTH
                .saturating_sub(x * cells_per_texel)
                .min(cells_per_texel);
            let covered_height = WORLD_HEIGHT
                .saturating_sub(y * cells_per_texel)
                .min(cells_per_texel);
            let maximum = covered_width * covered_height;
            if u32::from(*value) > maximum {
                return Err(Error::DensityRange {
                    z: level.z,
                    value: *value,
                    maximum,
                });
            }
            population += u64::from(*value);
        }
        if population != metadata.population {
            return Err(Error::LevelPopulation {
                z: level.z,
                expected: metadata.population,
                actual: population,
            });
        }
    }
    for parent_index in 0..levels.len() - 1 {
        validate_parent_sums(&levels[parent_index], &levels[parent_index + 1])?;
    }

    let cell_tiles = tiles.iter().filter(|tile| tile.coordinate.z == MAX_ZOOM);
    let mut roundtrip = vec![0u8; CANONICAL_BYTES];
    let mut roundtrip_population = 0u64;
    for tile in cell_tiles {
        let x = tile.coordinate.x;
        let y = tile.coordinate.y;
        let valid_bytes = ((WORLD_WIDTH.saturating_sub(x * TILE_SIZE)).min(TILE_SIZE) / 8) as usize;
        for local_y in 0..TILE_SIZE {
            let world_y = y * TILE_SIZE + local_y;
            if world_y >= WORLD_HEIGHT {
                break;
            }
            let tile_offset = local_y as usize * 32;
            let world_offset = world_y as usize * ROW_BYTES + (x * TILE_SIZE / 8) as usize;
            let source = &tile.bytes[tile_offset..tile_offset + valid_bytes];
            roundtrip[world_offset..world_offset + valid_bytes].copy_from_slice(source);
            roundtrip_population += source
                .iter()
                .map(|byte| u64::from(byte.count_ones()))
                .sum::<u64>();
        }
    }
    if roundtrip != canonical {
        return Err(Error::TileRoundtrip);
    }
    if roundtrip_population != metadata.population {
        return Err(Error::Population {
            expected: metadata.population,
            actual: roundtrip_population,
        });
    }
    let digest = digest_canonical(metadata.generation, &roundtrip);
    if digest != metadata.state_digest {
        return Err(Error::Digest {
            expected: hex_digest(&metadata.state_digest),
            actual: hex_digest(&digest),
        });
    }
    Ok(())
}

fn validate_edge_padding(tile: &Tile) -> Result<()> {
    let cells_per_texel = 1u32 << (MAX_ZOOM - tile.coordinate.z);
    for local_y in 0..TILE_SIZE {
        for local_x in 0..TILE_SIZE {
            let outside = (tile.coordinate.x * TILE_SIZE + local_x) * cells_per_texel
                >= WORLD_WIDTH
                || (tile.coordinate.y * TILE_SIZE + local_y) * cells_per_texel >= WORLD_HEIGHT;
            if !outside {
                continue;
            }
            let nonzero = if tile.coordinate.z == MAX_ZOOM {
                let byte = tile.bytes[local_y as usize * 32 + local_x as usize / 8];
                byte & (1 << (local_x % 8)) != 0
            } else {
                let offset = ((local_y * TILE_SIZE + local_x) * 2) as usize;
                tile.bytes[offset] != 0 || tile.bytes[offset + 1] != 0
            };
            if nonzero {
                return Err(Error::EdgePadding {
                    z: tile.coordinate.z,
                    x: tile.coordinate.x,
                    y: tile.coordinate.y,
                });
            }
        }
    }
    Ok(())
}

fn validate_parent_sums(parent: &DensityLevel, child: &DensityLevel) -> Result<()> {
    for y in 0..parent.height {
        for x in 0..parent.width {
            let mut sum = 0u16;
            for child_y in y * 2..(y * 2 + 2).min(child.height) {
                for child_x in x * 2..(x * 2 + 2).min(child.width) {
                    sum += child.values[(child_y * child.width + child_x) as usize];
                }
            }
            if parent.values[(y * parent.width + x) as usize] != sum {
                return Err(Error::ParentSum { z: parent.z, x, y });
            }
        }
    }
    Ok(())
}

fn digest_canonical(generation: u64, canonical: &[u8]) -> [u8; 32] {
    let mut digest = WorldDigest::new(WORLD_WIDTH, WORLD_HEIGHT, generation);
    for row in 0..WORLD_HEIGHT as usize {
        let bytes = &canonical[row * ROW_BYTES..(row + 1) * ROW_BYTES];
        digest.update((row * 2) as u32, &bytes[..CHUNK_BYTES]);
        digest.update((row * 2 + 1) as u32, &bytes[CHUNK_BYTES..]);
    }
    digest.finish()
}

fn tile_count_axis(z: u8) -> Option<u32> {
    (z <= MAX_ZOOM).then(|| {
        let cells_per_texel = 1u32 << (MAX_ZOOM - z);
        WORLD_WIDTH.div_ceil(TILE_SIZE * cells_per_texel)
    })
}

fn hex_digest(value: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(value))
}

fn coordinate_string(coordinate: TileCoordinate) -> String {
    format!("{}/{}/{}", coordinate.z, coordinate.x, coordinate.y)
}
