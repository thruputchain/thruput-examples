use game_of_life_core::digest::WorldDigest;
use game_of_life_core::prng::SplitMix64;
use game_of_life_indexer::{
    CHUNK_BYTES, CHUNKS_PER_ROW, ChunkResponse, Error, EventKind, EvidenceKind, LifeManifest,
    LifeProvenance, SnapshotMetadata, TileCoordinate, WORLD_HEIGHT, WORLD_WIDTH, build_snapshot,
    reconstruct_canonical_world,
};
use sha2::{Digest, Sha256};

const NETWORK_ID: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const CONTRACT: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const BLOCK_HASH: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";

#[test]
fn reconstruction_trims_tail_padding_and_accepts_unordered_chunks() {
    let (metadata, mut chunks) = dead_fixture();
    chunks[1].bytes.resize(CHUNK_BYTES, 0xff);
    chunks.reverse();

    let canonical = reconstruct_canonical_world(&metadata, chunks).expect("valid fixture");

    assert_eq!(canonical.len(), 12_500_000);
}

#[test]
fn reconstruction_accepts_canonical_tail_length() {
    let (metadata, chunks) = dead_fixture();

    let canonical = reconstruct_canonical_world(&metadata, chunks).expect("canonical tails");

    assert_eq!(canonical.len(), 12_500_000);
}

#[test]
fn reconstruction_rejects_short_and_long_chunk_payloads() {
    let (metadata, mut chunks) = dead_fixture();
    chunks[0].bytes.pop();
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("short head must fail"),
        Error::ChunkLength {
            row: 0,
            part: 0,
            actual: 999,
            expected: "exactly 1000 bytes",
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[1].bytes.resize(251, 0);
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("long canonical tail must fail"),
        Error::ChunkLength {
            row: 0,
            part: 1,
            actual: 251,
            expected: "exactly 250 or 1000 bytes",
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[0].bytes.push(0);
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("long head must fail"),
        Error::ChunkLength {
            row: 0,
            part: 0,
            actual: 1001,
            expected: "exactly 1000 bytes",
        }
    );
}

#[test]
fn reconstruction_rejects_missing_and_out_of_range_chunks() {
    let (metadata, mut chunks) = dead_fixture();
    chunks.pop();
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("missing chunk must fail"),
        Error::ChunkCount {
            expected: 20_000,
            actual: 19_999,
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[0].row = WORLD_HEIGHT;
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("row must be bounded"),
        Error::ChunkCoordinate {
            row: WORLD_HEIGHT,
            part: 0,
        }
    );

    let (_, mut chunks) = dead_fixture();
    chunks[0].part = CHUNKS_PER_ROW;
    assert_eq!(
        reconstruct_canonical_world(&metadata, chunks).expect_err("part must be bounded"),
        Error::ChunkCoordinate {
            row: 0,
            part: CHUNKS_PER_ROW,
        }
    );
}

#[test]
fn reconstruction_rejects_duplicate_coordinates() {
    let (metadata, mut chunks) = dead_fixture();
    chunks[2].row = 0;
    chunks[2].part = 0;

    let error = reconstruct_canonical_world(&metadata, chunks).expect_err("duplicate must fail");

    assert_eq!(error, Error::DuplicateChunk { row: 0, part: 0 });
}

#[test]
fn reconstruction_rejects_wrong_population_before_digest() {
    let (mut metadata, chunks) = dead_fixture();
    metadata.population = 1;

    let error = reconstruct_canonical_world(&metadata, chunks).expect_err("population must fail");

    assert_eq!(
        error,
        Error::Population {
            expected: 1,
            actual: 0
        }
    );
}

#[test]
fn reconstruction_rejects_wrong_digest() {
    let (mut metadata, chunks) = dead_fixture();
    metadata.state_digest[0] ^= 1;

    let error = reconstruct_canonical_world(&metadata, chunks).expect_err("digest must fail");

    assert!(matches!(error, Error::Digest { .. }));
}

#[test]
fn metadata_rejects_every_unsupported_layout_field() {
    let (metadata, _) = dead_fixture();
    for (field, mut candidate) in [
        ("width", metadata.clone()),
        ("height", metadata.clone()),
        ("chunk_bytes", metadata.clone()),
        ("chunks_per_row", metadata.clone()),
        ("max_queue_len", metadata.clone()),
    ] {
        match field {
            "width" => candidate.width -= 1,
            "height" => candidate.height -= 1,
            "chunk_bytes" => candidate.chunk_bytes -= 1,
            "chunks_per_row" => candidate.chunks_per_row -= 1,
            "max_queue_len" => candidate.max_queue_len = 0,
            _ => unreachable!(),
        }
        assert!(matches!(
            candidate.validate(),
            Err(Error::UnsupportedMetadata { field: actual, .. }) if actual == field
        ));
    }
}

#[test]
fn full_dead_fixture_builds_exact_edge_tiles_and_deterministic_artifacts() {
    let (metadata, chunks) = dead_fixture();
    let first = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("first snapshot");
    let first_hashes = artifact_hashes(&first);
    drop(first);

    let (_, chunks) = dead_fixture();
    let second = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("second snapshot");

    assert_eq!(second.artifacts.len(), 2_141);
    assert_eq!(
        second.artifacts.last().unwrap().path.as_str(),
        "manifest.json"
    );
    assert_eq!(
        second.artifacts[second.artifacts.len() - 2].path.as_str(),
        "provenance.json"
    );
    assert_eq!(first_hashes, artifact_hashes(&second));

    let expected_paths: Vec<_> = (0..=6)
        .flat_map(|z| {
            let count = [1, 2, 3, 5, 10, 20, 40][z as usize];
            (0..count).flat_map(move |x| (0..count).map(move |y| format!("tiles/{z}/{x}/{y}.bin")))
        })
        .collect();
    let actual_paths: Vec<_> = second.artifacts[..2_139]
        .iter()
        .map(|artifact| artifact.path.as_str())
        .collect();
    assert_eq!(actual_paths, expected_paths);
    assert_eq!(actual_paths[1], "tiles/1/0/0.bin");
    assert_eq!(actual_paths[2], "tiles/1/0/1.bin");
    assert_eq!(actual_paths[3], "tiles/1/1/0.bin");

    let density_edge = artifact(&second, "tiles/0/0/0.bin");
    assert_eq!(density_edge.len(), 131_072);
    assert!(density_edge.iter().all(|byte| *byte == 0));
    let cell_edge = artifact(&second, "tiles/6/39/39.bin");
    assert_eq!(cell_edge.len(), 8_192);
    assert!(cell_edge.iter().all(|byte| *byte == 0));
}

#[test]
fn sparse_world_density_tiles_encode_exact_counts_across_boundaries() {
    let mut cells = vec![
        (0, 0),
        (1, 0),
        (7, 1),
        (8, 1),
        (511, 511),
        (512, 512),
        (9_998, 9_999),
        (9_999, 9_999),
    ];
    cells.extend((1_000..1_020).flat_map(|x| (1_000..1_015).map(move |y| (x, y))));
    let (metadata, chunks) = fixture_from_cells(&cells);
    let snapshot = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("sparse snapshot");

    assert_eq!(density_count(&snapshot, 5, 0, 0), 2);
    assert_eq!(density_count(&snapshot, 5, 7, 1), 1);
    assert_eq!(density_count(&snapshot, 5, 8, 1), 1);
    assert_eq!(density_count(&snapshot, 5, 511, 511), 1);
    assert_eq!(density_count(&snapshot, 5, 512, 512), 1);
    assert_eq!(density_count(&snapshot, 5, 9_999, 9_999), 2);
    assert_eq!(density_count(&snapshot, 0, 1_000, 1_000), 300);
    assert_eq!(density_bytes(&snapshot, 0, 1_000, 1_000), [44, 1]);

    let right_bottom = artifact(&snapshot, "tiles/5/19/19.bin");
    assert_eq!(density_tile_value(right_bottom, 135, 135), 2);
    assert_eq!(density_tile_value(right_bottom, 136, 135), 0);
    assert_eq!(density_tile_value(right_bottom, 135, 136), 0);
}

#[test]
fn coordinate_validation_covers_non_power_of_two_edges() {
    let counts = [1, 2, 3, 5, 10, 20, 40];
    for (z, count) in counts.into_iter().enumerate() {
        assert!(TileCoordinate::new(z as u8, count - 1, count - 1).is_ok());
        assert_eq!(
            TileCoordinate::new(z as u8, count, 0),
            Err(Error::TileCoordinate {
                z: z as u8,
                x: count,
                y: 0,
            })
        );
    }
}

#[test]
fn manifest_json_is_compact_strict_and_confined() {
    let (metadata, _) = dead_fixture();
    let identity = game_of_life_indexer::SnapshotIdentity {
        network_id: NETWORK_ID.into(),
        contract_address: CONTRACT.into(),
        generation: metadata.generation,
        seed: metadata.seed,
        population: metadata.population,
        state_digest: metadata.state_digest,
    };
    let manifest = LifeManifest::new(&identity);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    assert!(!bytes.contains(&b'\n'));
    assert_eq!(LifeManifest::from_json(&bytes).unwrap(), manifest);

    let mut value = serde_json::to_value(&manifest).unwrap();
    value["tilePathTemplate"] = "../tiles/{z}/{x}/{y}.bin".into();
    assert!(LifeManifest::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
    value["tilePathTemplate"] = "tiles/{z}/{x}/{y}.bin".into();
    value["unknown"] = true.into();
    assert!(LifeManifest::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
#[ignore = "full random 100-million-cell fixture; run in release mode"]
fn full_seed_zero_fixture_matches_contract_and_is_deterministic() {
    let (metadata, chunks) = seed_zero_fixture();
    assert_eq!(metadata.population, 49_999_272);
    assert_eq!(
        hex::encode(metadata.state_digest),
        "85d72e50016badafcf3bc5c7040d42900b0417c3adc6721015aa1147d6733e05"
    );
    let first = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("seed-zero snapshot");
    let hashes = artifact_hashes(&first);
    drop(first);

    let (_, chunks) = seed_zero_fixture();
    let second = build_snapshot(
        &metadata,
        NETWORK_ID.into(),
        CONTRACT.into(),
        chunks,
        provenance(&metadata),
    )
    .expect("repeat seed-zero snapshot");
    assert_eq!(hashes, artifact_hashes(&second));

    let edge = artifact(&second, "tiles/6/39/0.bin");
    for row in edge.as_chunks::<32>().0 {
        assert!(row[2..].iter().all(|byte| *byte == 0));
    }
}

fn dead_fixture() -> (SnapshotMetadata, Vec<ChunkResponse>) {
    fixture_with_fill(|_| {})
}

fn seed_zero_fixture() -> (SnapshotMetadata, Vec<ChunkResponse>) {
    let mut rng = SplitMix64::new(0);
    fixture_with_fill(|bytes| rng.fill_bytes(bytes))
}

fn fixture_with_fill(mut fill: impl FnMut(&mut [u8])) -> (SnapshotMetadata, Vec<ChunkResponse>) {
    let mut chunks = Vec::with_capacity((WORLD_HEIGHT * CHUNKS_PER_ROW) as usize);
    let mut digest = WorldDigest::new(WORLD_WIDTH, WORLD_HEIGHT, 0);
    let mut population = 0u64;
    for row in 0..WORLD_HEIGHT {
        for part in 0..CHUNKS_PER_ROW {
            let canonical_length = if part == 0 { CHUNK_BYTES } else { 250 };
            let mut bytes = vec![0u8; canonical_length];
            fill(&mut bytes);
            population += bytes
                .iter()
                .map(|byte| u64::from(byte.count_ones()))
                .sum::<u64>();
            digest.update(row * CHUNKS_PER_ROW + part, &bytes);
            chunks.push(ChunkResponse { row, part, bytes });
        }
    }
    (
        SnapshotMetadata {
            width: WORLD_WIDTH,
            height: WORLD_HEIGHT,
            generation: 0,
            seed: 0,
            population,
            state_digest: digest.finish(),
            chunk_bytes: CHUNK_BYTES as u32,
            chunks_per_row: CHUNKS_PER_ROW,
            max_queue_len: 16,
        },
        chunks,
    )
}

fn fixture_from_cells(cells: &[(u32, u32)]) -> (SnapshotMetadata, Vec<ChunkResponse>) {
    let (_, mut chunks) = dead_fixture();
    for &(x, y) in cells {
        let byte_in_row = x as usize / 8;
        let part = usize::from(byte_in_row >= CHUNK_BYTES);
        let chunk = &mut chunks[y as usize * CHUNKS_PER_ROW as usize + part];
        chunk.bytes[byte_in_row % CHUNK_BYTES] |= 1 << (x % 8);
    }

    let mut digest = WorldDigest::new(WORLD_WIDTH, WORLD_HEIGHT, 0);
    let mut population = 0;
    for (key, chunk) in chunks.iter().enumerate() {
        population += chunk
            .bytes
            .iter()
            .map(|byte| u64::from(byte.count_ones()))
            .sum::<u64>();
        digest.update(key as u32, &chunk.bytes);
    }
    (
        SnapshotMetadata {
            width: WORLD_WIDTH,
            height: WORLD_HEIGHT,
            generation: 0,
            seed: 0,
            population,
            state_digest: digest.finish(),
            chunk_bytes: CHUNK_BYTES as u32,
            chunks_per_row: CHUNKS_PER_ROW,
            max_queue_len: 16,
        },
        chunks,
    )
}

fn provenance(metadata: &SnapshotMetadata) -> LifeProvenance {
    LifeProvenance {
        schema_version: 1,
        network_id: NETWORK_ID.into(),
        contract_address: CONTRACT.into(),
        generation: metadata.generation.to_string(),
        seed: metadata.seed.to_string(),
        population: metadata.population.to_string(),
        state_digest: format!("0x{}", hex::encode(metadata.state_digest)),
        source_block_height: "42".into(),
        source_block_hash: BLOCK_HASH.into(),
        evidence_kind: EvidenceKind::WorldInitializedEvent,
        transaction_hash: Some(
            "0x4444444444444444444444444444444444444444444444444444444444444444".into(),
        ),
        event_index: Some(0),
        event_kind: Some(EventKind::WorldInitialized),
        request_id: None,
        requester: None,
        verified_at: "2026-08-28T12:00:00Z".into(),
    }
}

fn artifact<'a>(snapshot: &'a game_of_life_indexer::Snapshot, path: &str) -> &'a [u8] {
    &snapshot
        .artifacts
        .iter()
        .find(|artifact| artifact.path.as_str() == path)
        .unwrap()
        .bytes
}

fn artifact_hashes(snapshot: &game_of_life_indexer::Snapshot) -> Vec<(String, [u8; 32])> {
    snapshot
        .artifacts
        .iter()
        .map(|artifact| {
            (
                artifact.path.as_str().to_owned(),
                Sha256::digest(&artifact.bytes).into(),
            )
        })
        .collect()
}

fn density_count(snapshot: &game_of_life_indexer::Snapshot, z: u8, x: u32, y: u32) -> u16 {
    u16::from_le_bytes(density_bytes(snapshot, z, x, y))
}

fn density_bytes(snapshot: &game_of_life_indexer::Snapshot, z: u8, x: u32, y: u32) -> [u8; 2] {
    let cells_per_texel = 1u32 << (6 - z);
    let texel_x = x / cells_per_texel;
    let texel_y = y / cells_per_texel;
    let tile_x = texel_x / 256;
    let tile_y = texel_y / 256;
    let bytes = artifact(snapshot, &format!("tiles/{z}/{tile_x}/{tile_y}.bin"));
    let offset = (((texel_y % 256) * 256 + texel_x % 256) * 2) as usize;
    [bytes[offset], bytes[offset + 1]]
}

fn density_tile_value(bytes: &[u8], x: u32, y: u32) -> u16 {
    let offset = ((y * 256 + x) * 2) as usize;
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}
