use std::fs::{self, File};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use game_of_life_core::digest::WorldDigest;
use game_of_life_indexer::service::initial_status;
use game_of_life_indexer::service::{
    FailurePoint, IndexerService, ServiceConfig, ServiceError, retry_delay,
};
use game_of_life_indexer::source::{
    ChainEvent, ChainSource, CoherentDownload, EventBatch, SourceError,
};
use game_of_life_indexer::state::StateStore;
use game_of_life_indexer::storage::{ProbeFailure, Publisher, StorageError};
use game_of_life_indexer::web::{HttpService, heartbeat_with_interval};
use game_of_life_indexer::{
    CHUNK_BYTES, CHUNKS_PER_ROW, ChunkResponse, EventKind, EvidenceKind, LatestPointer,
    LifeManifest, LifeProvenance, MAX_ZOOM, ProgressUnit, PublishedIdentity, SnapshotIdentity,
    SnapshotMetadata, TAIL_BYTES, WORLD_HEIGHT, WORLD_WIDTH,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;

const NETWORK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST0: &str = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST1: &str = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const DIGEST2: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

#[test]
fn filesystem_probe_refuses_startup_when_rename_fails() {
    let temp = tempfile::tempdir().expect("tempdir");
    let error = Publisher::open_with_probe_failure(temp.path().to_owned(), ProbeFailure::Rename)
        .err()
        .expect("probe should fail");
    assert!(matches!(error, StorageError::Unsupported(message) if message.contains("rename")));
    assert_no_probe_files(temp.path());
    let _publisher = Publisher::open(temp.path().to_owned()).expect("reopen after rename failure");
}

#[test]
fn filesystem_probe_refuses_startup_when_directory_fsync_fails() {
    let temp = tempfile::tempdir().expect("tempdir");
    let error =
        Publisher::open_with_probe_failure(temp.path().to_owned(), ProbeFailure::DirectorySync)
            .err()
            .expect("probe should fail");
    assert!(
        matches!(error, StorageError::Unsupported(message) if message.contains("directory fsync"))
    );
    assert_no_probe_files(temp.path());
    let _publisher =
        Publisher::open(temp.path().to_owned()).expect("reopen after directory fsync failure");
}

fn assert_no_probe_files(root: &std::path::Path) {
    assert!(fs::read_dir(root).expect("artifact root").all(|entry| {
        !entry
            .expect("artifact entry")
            .file_name()
            .to_string_lossy()
            .starts_with(".durability-probe.")
    }));
}

#[test]
fn second_writer_is_refused() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let _first = Publisher::open(root.clone()).expect("first writer");
    let error = Publisher::open(root)
        .err()
        .expect("second writer must be refused");
    assert!(matches!(error, StorageError::WriterActive));
}

#[tokio::test]
async fn mixed_generation_download_is_rejected_before_publication() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let publisher = Publisher::open(root.clone()).expect("publisher");
    let state = StateStore::open(&temp.path().join("state.sqlite3")).expect("state");
    let status = Arc::new(RwLock::new(initial_status()));
    let mut service = IndexerService::new(
        ServiceConfig {
            network_id: NETWORK.into(),
            contract_address: CONTRACT.into(),
            poll_interval: Duration::from_millis(1),
            retention_grace: Duration::from_secs(60),
            max_retry_backoff: Duration::from_secs(8),
        },
        MixedSource,
        state,
        publisher,
        status,
    );
    let error = service.cycle().await.expect_err("mixed generation");
    assert!(matches!(error, ServiceError::Source(SourceError::Mixed(_))));
    assert!(
        !root
            .join("v1/worlds")
            .join(NETWORK)
            .join(CONTRACT)
            .join("latest.json")
            .exists()
    );
}

#[test]
fn interrupted_publication_cannot_advance_latest() {
    let fixture = Fixture::new();
    let base = fixture.digest_dir(DIGEST0);
    fs::create_dir_all(&base).expect("create incomplete candidate");
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect_err("incomplete candidate must fail");
    assert!(matches!(error, StorageError::Io { .. }));
    assert!(!fixture.latest().exists());
}

#[test]
fn stale_build_does_not_replace_latest() {
    let fixture = Fixture::new();
    fixture.ready(2, DIGEST2);
    fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(2, DIGEST2))
        .expect("promote generation two");
    fixture.ready(1, DIGEST1);
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(1, DIGEST1))
        .expect_err("stale candidate must fail");
    assert!(matches!(
        error,
        StorageError::Stale {
            candidate: 1,
            latest: 2
        }
    ));
}

#[test]
fn generation_mismatch_cannot_poison_latest_as_stale() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(99, DIGEST0))
        .expect_err("pointer generation must match ready artifacts");
    assert!(matches!(error, StorageError::Collision(_)));
    assert!(!fixture.latest().exists());

    fixture.ready(1, DIGEST1);
    assert!(
        fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(1, DIGEST1))
            .expect("valid generation must not be made stale")
    );
}

#[test]
fn source_block_mismatch_is_rejected_by_promote_and_latest() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let mut mismatched = pointer(0, DIGEST0);
    mismatched.source_block_height = "10".into();
    assert!(matches!(
        fixture.publisher.promote(NETWORK, CONTRACT, &mismatched),
        Err(StorageError::Collision(_))
    ));

    fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect("promote matching pointer");
    mismatched.source_block_height = "9".into();
    mismatched.source_block_hash = format!("0x{}", "e".repeat(64));
    fs::write(
        fixture.latest(),
        serde_json::to_vec(&mismatched).expect("latest JSON"),
    )
    .expect("poison latest source block");
    assert!(matches!(
        fixture.publisher.latest(NETWORK, CONTRACT),
        Err(StorageError::Collision(_))
    ));
}

#[test]
fn digest_mismatch_cannot_be_promoted() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    fs::rename(fixture.digest_dir(DIGEST0), fixture.digest_dir(DIGEST1))
        .expect("move mismatched candidate");
    let error = fixture
        .publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST1))
        .expect_err("wrong digest path must fail");
    assert!(matches!(error, StorageError::Collision(_)));
}

#[test]
fn manifest_and_provenance_identity_mismatch_cannot_be_promoted() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let path = fixture.digest_dir(DIGEST0).join("provenance.json");
    let mut provenance =
        LifeProvenance::from_json(&fs::read(&path).expect("provenance")).expect("valid provenance");
    provenance.population = "1".into();
    fs::write(&path, serde_json::to_vec(&provenance).expect("JSON")).expect("rewrite provenance");
    assert!(matches!(
        fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0)),
        Err(StorageError::Collision(_))
    ));
}

#[test]
fn repeated_promotion_is_idempotent() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    assert!(
        fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
            .expect("first promotion")
    );
    assert!(
        !fixture
            .publisher
            .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
            .expect("repeat promotion")
    );
}

#[test]
fn restart_restores_cursor_and_verified_evidence() {
    let temp = tempfile::tempdir().expect("tempdir");
    let database = temp.path().join("state.sqlite3");
    let provenance = provenance(0, DIGEST0);
    {
        let state = StateStore::open(&database).expect("open state");
        state.set_cursor("scope", b"cursor").expect("save cursor");
        state.save_evidence(&provenance).expect("save evidence");
    }
    let state = StateStore::open(&database).expect("reopen state");
    assert_eq!(
        state.cursor("scope").expect("load cursor"),
        Some(b"cursor".to_vec())
    );
    assert_eq!(
        state
            .evidence(NETWORK, CONTRACT, DIGEST0)
            .expect("load evidence"),
        Some(provenance)
    );
}

#[test]
fn evidence_selection_reuses_bytes_and_rejects_conflicts() {
    let temp = tempfile::tempdir().expect("tempdir");
    let state = StateStore::open(&temp.path().join("state.sqlite3")).expect("state");
    let original = event_provenance(0, DIGEST0, "2026-08-28T12:00:00.000Z");
    assert_eq!(
        state.resolve_evidence(&original).expect("resolve evidence"),
        None
    );
    assert_eq!(
        state
            .evidence(NETWORK, CONTRACT, DIGEST0)
            .expect("evidence remains absent"),
        None
    );
    let selected = state.persist_evidence(&original).expect("persist evidence");
    let mut retry = original.clone();
    retry.verified_at = "2026-08-28T13:00:00.000Z".into();
    retry.source_block_height = "10".into();
    retry.source_block_hash = format!("0x{}", "e".repeat(64));
    assert_eq!(
        state.resolve_evidence(&retry).expect("reuse evidence"),
        Some(selected)
    );
    retry.transaction_hash = Some(format!("0x{}", "1".repeat(64)));
    assert!(matches!(
        state.resolve_evidence(&retry),
        Err(game_of_life_indexer::state::StateError::EvidenceConflict { .. })
    ));
}

#[tokio::test]
async fn artifact_interruption_retries_with_identical_immutable_evidence() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let database = temp.path().join("state.sqlite3");
    let metadata = dead_metadata(0);
    let digest = format!("0x{}", hex::encode(metadata.state_digest));
    let downloads = Arc::new(AtomicUsize::new(0));
    let source = ChangingAnchorSource {
        inner: DeadSource::new(metadata.clone()),
        downloads: Arc::clone(&downloads),
    };
    let status = Arc::new(RwLock::new(initial_status()));
    let mut service = IndexerService::new(
        service_config(),
        source,
        StateStore::open(&database).expect("state"),
        Publisher::open(root.clone()).expect("publisher"),
        status,
    );
    service.inject_failure(FailurePoint::AfterArtifacts);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::Injected(FailurePoint::AfterArtifacts))
    ));
    let candidate = root
        .join("v1/worlds")
        .join(NETWORK)
        .join(CONTRACT)
        .join(&digest);
    let manifest_before = fs::read(candidate.join("manifest.json")).expect("manifest");
    let provenance_before = fs::read(candidate.join("provenance.json")).expect("provenance");
    let original_provenance = StateStore::open(&database)
        .expect("observer")
        .evidence(NETWORK, CONTRACT, &digest)
        .expect("evidence lookup")
        .expect("verified evidence");
    assert_eq!(original_provenance.source_block_height, "1");
    assert!(
        !candidate
            .parent()
            .expect("scope")
            .join("latest.json")
            .exists()
    );
    service.cycle().await.expect("resume publication");
    assert_eq!(
        fs::read(candidate.join("manifest.json")).expect("manifest after retry"),
        manifest_before
    );
    assert_eq!(
        fs::read(candidate.join("provenance.json")).expect("provenance after retry"),
        provenance_before
    );
    assert_eq!(downloads.load(Ordering::SeqCst), 2);
    let latest = LatestPointer::from_json_for(
        &fs::read(candidate.parent().expect("scope").join("latest.json")).expect("latest"),
        NETWORK,
        CONTRACT,
    )
    .expect("valid latest");
    assert_eq!(latest.source_block_height, "1");
    assert_eq!(
        latest.source_block_hash,
        original_provenance.source_block_hash
    );
    assert!(
        candidate
            .parent()
            .expect("scope")
            .join("latest.json")
            .exists()
    );
}

#[tokio::test]
async fn failed_snapshot_verification_does_not_persist_evidence() {
    let temp = tempfile::tempdir().expect("tempdir");
    let database = temp.path().join("state.sqlite3");
    let mut metadata = dead_metadata(0);
    metadata.state_digest = [9; 32];
    let digest = format!("0x{}", hex::encode(metadata.state_digest));
    let mut service = IndexerService::new(
        service_config(),
        DeadSource::new(metadata),
        StateStore::open(&database).expect("state"),
        Publisher::open(temp.path().join("artifacts")).expect("publisher"),
        Arc::new(RwLock::new(initial_status())),
    );
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::Snapshot(_))
    ));
    assert!(
        StateStore::open(&database)
            .expect("observer")
            .evidence(NETWORK, CONTRACT, &digest)
            .expect("evidence lookup")
            .is_none()
    );
}

#[tokio::test]
async fn event_lag_retains_one_download_and_publishes_fixed_historical_candidate() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let metadata = dead_metadata(0);
    let digest = format!("0x{}", hex::encode(metadata.state_digest));
    let metadata_calls = Arc::new(AtomicUsize::new(0));
    let downloads = Arc::new(AtomicUsize::new(0));
    let event_calls = Arc::new(AtomicUsize::new(0));
    let source = MovingTipSource {
        initial: metadata.clone(),
        advanced: dead_metadata(1),
        event: DeadSource::new(metadata).event,
        metadata_calls: Arc::clone(&metadata_calls),
        downloads: Arc::clone(&downloads),
        event_calls: Arc::clone(&event_calls),
    };
    let mut service = IndexerService::new(
        service_config(),
        source,
        StateStore::open(&temp.path().join("state.sqlite3")).expect("state"),
        Publisher::open(root.clone()).expect("publisher"),
        Arc::new(RwLock::new(initial_status())),
    );
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::EventIndexBehind {
            latest_block: 4,
            source_block: 5
        })
    ));
    service
        .cycle()
        .await
        .expect("publish retained historical candidate");
    assert_eq!(metadata_calls.load(Ordering::SeqCst), 1);
    assert_eq!(downloads.load(Ordering::SeqCst), 1);
    assert_eq!(event_calls.load(Ordering::SeqCst), 2);
    let latest = fs::read(
        root.join("v1/worlds")
            .join(NETWORK)
            .join(CONTRACT)
            .join("latest.json"),
    )
    .expect("latest");
    let latest = LatestPointer::from_json_for(&latest, NETWORK, CONTRACT).expect("valid latest");
    assert_eq!(latest.generation, "0");
    assert_eq!(latest.state_digest, digest);
    assert_eq!(latest.source_block_height, "5");
}

#[tokio::test]
async fn status_reports_chunk_tile_and_file_preparation_boundaries() {
    let temp = tempfile::tempdir().expect("tempdir");
    let metadata = dead_metadata(0);
    let digest = format!("0x{}", hex::encode(metadata.state_digest));
    let status = Arc::new(RwLock::new(initial_status()));
    let previous = PublishedIdentity {
        generation: "9".into(),
        state_digest: DIGEST0.into(),
    };
    status.write().await.published = Some(previous.clone());
    let downloads = Arc::new(AtomicUsize::new(0));
    let source = StatusObservingSource {
        inner: DeadSource::new(metadata),
        status: Arc::clone(&status),
        downloads: Arc::clone(&downloads),
    };
    let mut service = IndexerService::new(
        service_config(),
        source,
        StateStore::open(&temp.path().join("state.sqlite3")).expect("state"),
        Publisher::open(temp.path().join("artifacts")).expect("publisher"),
        Arc::clone(&status),
    );

    service.inject_failure(FailurePoint::AfterDownload);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::Injected(FailurePoint::AfterDownload))
    ));
    assert_progress(
        &status,
        ProgressUnit::Chunks,
        20_000,
        20_000,
        &digest,
        &previous,
    )
    .await;

    service.inject_failure(FailurePoint::BeforeBuild);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::Injected(FailurePoint::BeforeBuild))
    ));
    assert_progress(&status, ProgressUnit::Tiles, 0, 2_139, &digest, &previous).await;

    service.inject_failure(FailurePoint::BeforeArtifacts);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::Injected(FailurePoint::BeforeArtifacts))
    ));
    assert_progress(&status, ProgressUnit::Files, 0, 2_141, &digest, &previous).await;
    assert_eq!(downloads.load(Ordering::SeqCst), 1);
}

async fn assert_progress(
    status: &Arc<RwLock<game_of_life_indexer::LifeStatus>>,
    unit: ProgressUnit,
    completed: u32,
    total: u32,
    digest: &str,
    published: &PublishedIdentity,
) {
    let status = status.read().await;
    let progress = status.preparing.as_ref().expect("preparing progress");
    assert_eq!(status.state, game_of_life_indexer::IndexerState::Preparing);
    assert_eq!(status.observed.as_ref().expect("observed").generation, "0");
    assert_eq!(
        status.observed.as_ref().expect("observed").state_digest,
        digest
    );
    assert_eq!(status.published.as_ref(), Some(published));
    assert_eq!(status.error_code, None);
    assert_eq!(status.retry, None);
    assert_eq!(progress.unit, unit);
    assert_eq!(progress.completed_units, completed);
    assert_eq!(progress.total_units, total);
}

#[tokio::test]
async fn promotion_crash_is_reconciled_before_fast_path_cleanup() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    fixture.ready(1, DIGEST1);
    let Fixture { temp, publisher } = fixture;
    let root = publisher.root().to_owned();
    let database = temp.path().join("state.sqlite3");
    let state = StateStore::open(&database).expect("state");
    let old = pointer(0, DIGEST0);
    publisher
        .promote(NETWORK, CONTRACT, &old)
        .expect("promote predecessor");
    state
        .record_publication(NETWORK, CONTRACT, 0, DIGEST0, 1)
        .expect("record predecessor");
    let metadata = dead_metadata(2);
    let digest = format!("0x{}", hex::encode(metadata.state_digest));
    let mut service = IndexerService::new(
        service_config(),
        DeadSource::new(metadata),
        state,
        publisher,
        Arc::new(RwLock::new(initial_status())),
    );
    service.inject_failure(FailurePoint::AfterPromotion);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::Injected(FailurePoint::AfterPromotion))
    ));
    let observer = StateStore::open(&database).expect("observer");
    assert!(
        observer
            .publication(NETWORK, CONTRACT, &digest)
            .expect("publication lookup")
            .is_none()
    );
    service.cycle().await.expect("repair promoted publication");
    let observer = StateStore::open(&database).expect("observer after repair");
    assert!(
        observer
            .publication(NETWORK, CONTRACT, &digest)
            .expect("current publication")
            .is_some()
    );
    assert!(
        observer
            .publication(NETWORK, CONTRACT, DIGEST0)
            .expect("predecessor publication")
            .is_some()
    );
    assert!(
        root.join("v1/worlds")
            .join(NETWORK)
            .join(CONTRACT)
            .join(DIGEST0)
            .exists()
    );
    assert!(
        !root
            .join("v1/worlds")
            .join(NETWORK)
            .join(CONTRACT)
            .join(DIGEST1)
            .exists()
    );
}

#[tokio::test]
async fn event_retention_gap_and_index_lag_block_publication() {
    let gap = EventBatch {
        events: Vec::new(),
        cursor: b"gap".to_vec(),
        exhausted: true,
        latest_block: 10,
        oldest_block: 5,
        retention_gap: true,
    };
    let (_temp, mut service) = gate_service(gap, 10);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::EventRetentionGap { oldest_block: 5 })
    ));
    let behind = EventBatch {
        events: Vec::new(),
        cursor: b"behind".to_vec(),
        exhausted: true,
        latest_block: 9,
        oldest_block: 0,
        retention_gap: false,
    };
    let (_temp, mut service) = gate_service(behind, 10);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::EventIndexBehind {
            latest_block: 9,
            source_block: 10
        })
    ));
}

#[tokio::test]
async fn missing_matching_lifecycle_event_blocks_publication() {
    let batch = EventBatch {
        events: Vec::new(),
        cursor: b"done".to_vec(),
        exhausted: true,
        latest_block: 10,
        oldest_block: 0,
        retention_gap: false,
    };
    let (_temp, mut service) = gate_service(batch, 10);
    assert!(matches!(
        service.cycle().await,
        Err(ServiceError::MissingLifecycleEvidence { generation: 0 })
    ));
}

#[tokio::test]
async fn retries_back_off_bound_and_reset_while_preserving_published_status() {
    assert_eq!(
        retry_delay(5, Duration::from_secs(1), Duration::from_secs(4)),
        Duration::from_secs(4)
    );
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let Fixture { temp, publisher } = fixture;
    publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect("promote ready fixture");
    let attempts = Arc::new(AtomicUsize::new(0));
    let status = Arc::new(RwLock::new(initial_status()));
    let mut service = IndexerService::new(
        ServiceConfig {
            network_id: NETWORK.into(),
            contract_address: CONTRACT.into(),
            poll_interval: Duration::from_millis(10),
            retention_grace: Duration::from_secs(60),
            max_retry_backoff: Duration::from_millis(20),
        },
        FailThenMetadata {
            attempts: Arc::clone(&attempts),
        },
        StateStore::open(&temp.path().join("state.sqlite3")).expect("state"),
        publisher,
        Arc::clone(&status),
    );
    assert_eq!(service.step().await, Duration::from_millis(10));
    assert_eq!(
        status
            .read()
            .await
            .retry
            .as_ref()
            .expect("retry one")
            .attempt,
        1
    );
    assert!(status.read().await.published.is_some());
    assert_eq!(service.step().await, Duration::from_millis(20));
    assert_eq!(
        status
            .read()
            .await
            .retry
            .as_ref()
            .expect("retry two")
            .attempt,
        2
    );
    assert_eq!(service.step().await, Duration::from_millis(10));
    assert!(status.read().await.retry.is_none());
}

#[tokio::test]
async fn unchanged_cycles_do_not_repeat_ready_inventory_discovery() {
    let fixture = Fixture::new();
    fixture.ready(0, DIGEST0);
    let Fixture { temp, publisher } = fixture;
    publisher
        .promote(NETWORK, CONTRACT, &pointer(0, DIGEST0))
        .expect("promote ready fixture");
    let missing_after_startup = publisher
        .root()
        .join("v1/worlds")
        .join(NETWORK)
        .join(CONTRACT)
        .join(DIGEST0)
        .join(format!("tiles/{MAX_ZOOM}/0/0.bin"));
    let mut service = IndexerService::new(
        service_config(),
        FailThenMetadata {
            attempts: Arc::new(AtomicUsize::new(2)),
        },
        StateStore::open(&temp.path().join("state.sqlite3")).expect("state"),
        publisher,
        Arc::new(RwLock::new(initial_status())),
    );

    service.cycle().await.expect("startup reconciliation");
    fs::remove_file(missing_after_startup).expect("remove tile after startup validation");
    service.cycle().await.expect("first unchanged cycle");
    service.cycle().await.expect("second unchanged cycle");
}

#[test]
fn cleanup_retains_current_predecessor_and_grace() {
    let fixture = Fixture::new();
    let database = fixture.temp.path().join("state.sqlite3");
    let state = StateStore::open(&database).expect("state");
    for (generation, digest, promoted) in [(0, DIGEST0, 1), (1, DIGEST1, 1), (2, DIGEST2, 100)] {
        fs::create_dir_all(fixture.digest_dir(digest)).expect("digest dir");
        state
            .record_publication(NETWORK, CONTRACT, generation, digest, promoted)
            .expect("record");
    }
    let retained = state
        .retained_digests(NETWORK, CONTRACT, 50)
        .expect("retained");
    let removed = fixture
        .publisher
        .cleanup(NETWORK, CONTRACT, &retained)
        .expect("cleanup");
    assert_eq!(removed, vec![DIGEST0.to_owned()]);
}

#[tokio::test]
async fn http_enforces_paths_headers_etags_cors_and_live_status() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.latest().parent().expect("scope")).expect("scope");
    fs::write(fixture.latest(), b"latest").expect("latest");
    let status = Arc::new(RwLock::new(initial_status()));
    status.write().await.heartbeat_at = "2026-08-28T12:00:00.000Z".into();
    let service = HttpService::new(
        fixture.publisher.root().to_owned(),
        Arc::clone(&status),
        NETWORK.into(),
        CONTRACT.into(),
        ["http://localhost:5173".into()],
    );
    let ok = service.handle(format!("GET /v1/worlds/{NETWORK}/{CONTRACT}/latest.json HTTP/1.1\r\nOrigin: http://localhost:5173\r\n\r\n").as_bytes()).await;
    let text = String::from_utf8(ok).expect("response");
    assert!(
        text.contains("HTTP/1.1 200 OK")
            && text.contains("Cache-Control: no-cache")
            && text.contains("ETag: \"")
            && text.contains("Access-Control-Allow-Origin: http://localhost:5173")
    );
    assert!(text.contains("Vary: Origin"));
    fs::create_dir_all(fixture.digest_dir(DIGEST0)).expect("immutable directory");
    fs::write(
        fixture.digest_dir(DIGEST0).join("manifest.json"),
        b"immutable",
    )
    .expect("immutable file");
    let immutable_path = format!("/v1/worlds/{NETWORK}/{CONTRACT}/{DIGEST0}/manifest.json");
    let immutable = service
        .handle(format!("GET {immutable_path} HTTP/1.1\r\n\r\n").as_bytes())
        .await;
    let immutable = String::from_utf8(immutable).expect("immutable response");
    assert!(immutable.contains("Cache-Control: public, max-age=31536000, immutable"));
    let etag = immutable
        .lines()
        .find_map(|line| line.strip_prefix("ETag: "))
        .expect("etag");
    let not_modified = service
        .handle(
            format!("GET {immutable_path} HTTP/1.1\r\nIf-None-Match: {etag}\r\n\r\n").as_bytes(),
        )
        .await;
    assert!(not_modified.starts_with(b"HTTP/1.1 304"));
    let weak_list = service
        .handle(
            format!("GET {immutable_path} HTTP/1.1\r\nIf-None-Match: \"other\", W/{etag}\r\n\r\n")
                .as_bytes(),
        )
        .await;
    assert!(weak_list.starts_with(b"HTTP/1.1 304"));
    let wildcard = service
        .handle(format!("GET {immutable_path} HTTP/1.1\r\nIf-None-Match: *\r\n\r\n").as_bytes())
        .await;
    assert!(wildcard.starts_with(b"HTTP/1.1 304"));
    let traversal = service
        .handle(b"GET /v1/worlds/../../etc/passwd HTTP/1.1\r\n\r\n")
        .await;
    assert!(traversal.starts_with(b"HTTP/1.1 404"));
    let denied = service.handle(format!("GET /v1/worlds/{NETWORK}/{CONTRACT}/status.json HTTP/1.1\r\nOrigin: https://evil.example\r\n\r\n").as_bytes()).await;
    assert!(denied.starts_with(b"HTTP/1.1 403"));
    let other_scope = service
        .handle(
            format!(
                "GET /v1/worlds/{}/{CONTRACT}/status.json HTTP/1.1\r\n\r\n",
                "f".repeat(64)
            )
            .as_bytes(),
        )
        .await;
    assert!(other_scope.starts_with(b"HTTP/1.1 404"));
    let truncated = service
        .handle(format!("GET {immutable_path} HTTP/1.1\r\nHost: local").as_bytes())
        .await;
    assert!(truncated.starts_with(b"HTTP/1.1 400"));
    let status_response = service
        .handle(
            format!("GET /v1/worlds/{NETWORK}/{CONTRACT}/status.json HTTP/1.1\r\n\r\n").as_bytes(),
        )
        .await;
    let status_body = std::str::from_utf8(&status_response)
        .expect("status response")
        .split("\r\n\r\n")
        .nth(1)
        .expect("status body");
    let served_status: game_of_life_indexer::LifeStatus =
        serde_json::from_str(status_body).expect("status JSON");
    assert_eq!(served_status.heartbeat_at, "2026-08-28T12:00:00.000Z");
    let before = status.read().await.heartbeat_at.clone();
    tokio::spawn(heartbeat_with_interval(
        Arc::clone(&status),
        Duration::from_millis(5),
    ));
    tokio::time::sleep(Duration::from_millis(12)).await;
    assert_ne!(status.read().await.heartbeat_at, before);
}

#[tokio::test]
async fn socket_http_parser_handles_fragmentation_overflow_truncation_and_timeout() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("artifacts");
    let latest = root
        .join("v1/worlds")
        .join(NETWORK)
        .join(CONTRACT)
        .join("latest.json");
    fs::create_dir_all(latest.parent().expect("scope")).expect("scope");
    fs::write(&latest, b"latest").expect("latest");
    let service = Arc::new(
        HttpService::new(
            root,
            Arc::new(RwLock::new(initial_status())),
            NETWORK.into(),
            CONTRACT.into(),
            Vec::<String>::new(),
        )
        .with_read_timeout_for_test(Duration::from_millis(30)),
    );
    let path = format!("/v1/worlds/{NETWORK}/{CONTRACT}/latest.json");

    let fragmented = socket_response(
        Arc::clone(&service),
        vec![
            format!("GET {path} HTTP/1.1\r\nHo").into_bytes(),
            b"st: localhost\r\n".to_vec(),
            b"\r\n".to_vec(),
        ],
        false,
    )
    .await;
    assert!(fragmented.starts_with(b"HTTP/1.1 200"));

    let oversized = socket_response(
        Arc::clone(&service),
        vec![
            format!("GET {path} HTTP/1.1\r\nX-Fill: ").into_bytes(),
            vec![b'a'; 8 * 1024],
            vec![b'b'; 8 * 1024],
            b"\r\n\r\n".to_vec(),
        ],
        false,
    )
    .await;
    assert!(oversized.starts_with(b"HTTP/1.1 431"));

    let incomplete = socket_response(
        Arc::clone(&service),
        vec![format!("GET {path} HTTP/1.1\r\nHost: local").into_bytes()],
        true,
    )
    .await;
    assert!(incomplete.starts_with(b"HTTP/1.1 400"));

    let timeout = socket_response(service, Vec::new(), false).await;
    assert!(timeout.starts_with(b"HTTP/1.1 408"));
}

async fn socket_response(
    service: Arc<HttpService>,
    fragments: Vec<Vec<u8>>,
    shutdown_write: bool,
) -> Vec<u8> {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("listener address");
    let client = TcpStream::connect(address);
    let server = listener.accept();
    let (client, server) = tokio::join!(client, server);
    let mut client = client.expect("client");
    let (server, _) = server.expect("server");
    let task = tokio::spawn(async move {
        service
            .serve_connection_for_test(server)
            .await
            .expect("serve connection");
    });
    for fragment in fragments {
        if client.write_all(&fragment).await.is_err() {
            break;
        }
        tokio::task::yield_now().await;
    }
    if shutdown_write {
        client.shutdown().await.expect("shutdown request");
    }
    let mut response = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut response))
        .await
        .expect("response timeout");
    if let Err(error) = read {
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
        assert!(!response.is_empty(), "connection reset before response");
    }
    task.await.expect("server task");
    response
}

struct Fixture {
    temp: tempfile::TempDir,
    publisher: Publisher,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let publisher = Publisher::open(temp.path().join("artifacts")).expect("publisher");
        Self { temp, publisher }
    }
    fn scope(&self) -> std::path::PathBuf {
        self.publisher
            .root()
            .join("v1/worlds")
            .join(NETWORK)
            .join(CONTRACT)
    }
    fn latest(&self) -> std::path::PathBuf {
        self.scope().join("latest.json")
    }
    fn digest_dir(&self, digest: &str) -> std::path::PathBuf {
        self.scope().join(digest)
    }
    fn ready(&self, generation: u64, digest: &str) {
        let base = self.digest_dir(digest);
        fs::create_dir_all(base.join("tiles")).expect("tiles");
        let identity = SnapshotIdentity {
            network_id: NETWORK.into(),
            contract_address: CONTRACT.into(),
            generation,
            seed: 7,
            population: 0,
            state_digest: decode_digest(digest),
        };
        fs::write(
            base.join("manifest.json"),
            serde_json::to_vec(&LifeManifest::new(&identity)).expect("manifest json"),
        )
        .expect("manifest");
        fs::write(
            base.join("provenance.json"),
            serde_json::to_vec(&provenance(generation, digest)).expect("provenance json"),
        )
        .expect("provenance");
        for z in 0..=MAX_ZOOM {
            let count = 10_000u32.div_ceil(256 * (1u32 << (MAX_ZOOM - z)));
            let length = if z == MAX_ZOOM { 8_192 } else { 131_072 };
            for x in 0..count {
                fs::create_dir_all(base.join(format!("tiles/{z}/{x}"))).expect("tile parent");
                for y in 0..count {
                    File::create(base.join(format!("tiles/{z}/{x}/{y}.bin")))
                        .and_then(|file| file.set_len(length))
                        .expect("sparse tile");
                }
            }
        }
    }
}

fn pointer(generation: u64, digest: &str) -> LatestPointer {
    LatestPointer {
        schema_version: 1,
        generation: generation.to_string(),
        state_digest: digest.into(),
        manifest_url: format!("/v1/worlds/{NETWORK}/{CONTRACT}/{digest}/manifest.json"),
        source_block_height: "9".into(),
        source_block_hash: format!("0x{}", "f".repeat(64)),
        published_at: "2026-08-28T12:00:00.000Z".into(),
    }
}
fn provenance(generation: u64, digest: &str) -> LifeProvenance {
    LifeProvenance {
        schema_version: 1,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        generation: generation.to_string(),
        seed: "7".into(),
        population: "0".into(),
        state_digest: digest.into(),
        source_block_height: "9".into(),
        source_block_hash: format!("0x{}", "f".repeat(64)),
        evidence_kind: EvidenceKind::MetadataObservation,
        transaction_hash: None,
        event_index: None,
        event_kind: None,
        request_id: None,
        requester: None,
        verified_at: "2026-08-28T12:00:00.000Z".into(),
    }
}
fn event_provenance(generation: u64, digest: &str, verified_at: &str) -> LifeProvenance {
    LifeProvenance {
        schema_version: 1,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        generation: generation.to_string(),
        seed: "7".into(),
        population: "0".into(),
        state_digest: digest.into(),
        source_block_height: "9".into(),
        source_block_hash: format!("0x{}", "f".repeat(64)),
        evidence_kind: EvidenceKind::WorldInitializedEvent,
        transaction_hash: Some(format!("0x{}", "0".repeat(64))),
        event_index: Some(0),
        event_kind: Some(EventKind::WorldInitialized),
        request_id: None,
        requester: None,
        verified_at: verified_at.into(),
    }
}
fn decode_digest(value: &str) -> [u8; 32] {
    hex::decode(&value[2..])
        .expect("hex")
        .try_into()
        .expect("digest")
}

struct MixedSource;

#[async_trait]
impl ChainSource for MixedSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(metadata(0))
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Ok(CoherentDownload {
            metadata: metadata(1),
            chunks: Vec::new(),
            source_block_height: 1,
            source_block_hash: [1; 32],
        })
    }

    async fn events(&self, _cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        Ok(EventBatch {
            events: Vec::new(),
            cursor: b"done".to_vec(),
            exhausted: true,
            latest_block: 1,
            oldest_block: 0,
            retention_gap: false,
        })
    }
}

fn metadata(generation: u64) -> SnapshotMetadata {
    SnapshotMetadata {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        generation,
        seed: 0,
        population: 0,
        state_digest: [0; 32],
        chunk_bytes: CHUNK_BYTES as u32,
        chunks_per_row: CHUNKS_PER_ROW,
        max_queue_len: 64,
    }
}

fn service_config() -> ServiceConfig {
    ServiceConfig {
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        poll_interval: Duration::from_millis(1),
        retention_grace: Duration::from_secs(60),
        max_retry_backoff: Duration::from_secs(1),
    }
}

#[derive(Clone)]
struct DeadSource {
    metadata: SnapshotMetadata,
    event: ChainEvent,
}

impl DeadSource {
    fn new(metadata: SnapshotMetadata) -> Self {
        let initialized = metadata.generation == 0;
        Self {
            event: ChainEvent {
                generation: metadata.generation,
                seed: initialized.then_some(metadata.seed),
                max_queue_len: initialized.then_some(metadata.max_queue_len),
                population: metadata.population,
                state_digest: metadata.state_digest,
                block_height: 1,
                transaction_hash: format!("0x{}", "1".repeat(64)),
                event_index: 0,
                request_id: (!initialized).then(|| format!("0x{}", "2".repeat(64))),
                requester: (!initialized).then(|| format!("0x{}", "3".repeat(64))),
                initialized,
            },
            metadata,
        }
    }
}

#[async_trait]
impl ChainSource for DeadSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(self.metadata.clone())
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Ok(CoherentDownload {
            metadata: self.metadata.clone(),
            chunks: dead_chunks(),
            source_block_height: 1,
            source_block_hash: [4; 32],
        })
    }

    async fn events(&self, _cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        Ok(EventBatch {
            events: vec![self.event.clone()],
            cursor: b"done".to_vec(),
            exhausted: true,
            latest_block: 1,
            oldest_block: 0,
            retention_gap: false,
        })
    }
}

struct StatusObservingSource {
    inner: DeadSource,
    status: Arc<RwLock<game_of_life_indexer::LifeStatus>>,
    downloads: Arc<AtomicUsize>,
}

#[async_trait]
impl ChainSource for StatusObservingSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        self.inner.metadata().await
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        let status = self.status.read().await;
        let progress = status.preparing.as_ref().expect("download progress");
        assert_eq!(status.state, game_of_life_indexer::IndexerState::Preparing);
        assert_eq!(progress.unit, ProgressUnit::Chunks);
        assert_eq!(progress.completed_units, 0);
        assert_eq!(progress.total_units, 20_000);
        drop(status);
        self.downloads.fetch_add(1, Ordering::SeqCst);
        self.inner.download().await
    }

    async fn events(&self, cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        self.inner.events(cursor).await
    }
}

struct ChangingAnchorSource {
    inner: DeadSource,
    downloads: Arc<AtomicUsize>,
}

#[async_trait]
impl ChainSource for ChangingAnchorSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        self.inner.metadata().await
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        let anchor = self.downloads.fetch_add(1, Ordering::SeqCst) as u64 + 1;
        let mut download = self.inner.download().await?;
        download.source_block_height = anchor;
        download.source_block_hash = [anchor as u8; 32];
        Ok(download)
    }

    async fn events(&self, cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        let mut batch = self.inner.events(cursor).await?;
        batch.latest_block = self.downloads.load(Ordering::SeqCst) as u64;
        Ok(batch)
    }
}

struct MovingTipSource {
    initial: SnapshotMetadata,
    advanced: SnapshotMetadata,
    event: ChainEvent,
    metadata_calls: Arc<AtomicUsize>,
    downloads: Arc<AtomicUsize>,
    event_calls: Arc<AtomicUsize>,
}

#[async_trait]
impl ChainSource for MovingTipSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        if self.metadata_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(self.initial.clone())
        } else {
            Ok(self.advanced.clone())
        }
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        Ok(CoherentDownload {
            metadata: self.initial.clone(),
            chunks: dead_chunks(),
            source_block_height: 5,
            source_block_hash: [5; 32],
        })
    }

    async fn events(&self, _cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        let caught_up = self.event_calls.fetch_add(1, Ordering::SeqCst) > 0;
        Ok(EventBatch {
            events: caught_up.then(|| self.event.clone()).into_iter().collect(),
            cursor: if caught_up { &b"done"[..] } else { &b"lag"[..] }.to_vec(),
            exhausted: true,
            latest_block: if caught_up { 5 } else { 4 },
            oldest_block: 0,
            retention_gap: false,
        })
    }
}

fn dead_metadata(generation: u64) -> SnapshotMetadata {
    let head = vec![0; CHUNK_BYTES];
    let tail = vec![0; TAIL_BYTES];
    let mut digest = WorldDigest::new(WORLD_WIDTH, WORLD_HEIGHT, generation);
    for row in 0..WORLD_HEIGHT {
        digest.update(row * CHUNKS_PER_ROW, &head);
        digest.update(row * CHUNKS_PER_ROW + 1, &tail);
    }
    SnapshotMetadata {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        generation,
        seed: 0,
        population: 0,
        state_digest: digest.finish(),
        chunk_bytes: CHUNK_BYTES as u32,
        chunks_per_row: CHUNKS_PER_ROW,
        max_queue_len: 64,
    }
}

fn dead_chunks() -> Vec<ChunkResponse> {
    let mut chunks = Vec::with_capacity((WORLD_HEIGHT * CHUNKS_PER_ROW) as usize);
    for row in 0..WORLD_HEIGHT {
        for part in 0..CHUNKS_PER_ROW {
            chunks.push(ChunkResponse {
                row,
                part,
                bytes: vec![0; if part == 0 { CHUNK_BYTES } else { TAIL_BYTES }],
            });
        }
    }
    chunks
}

#[derive(Clone)]
struct GateSource {
    batch: EventBatch,
    source_block: u64,
}

#[async_trait]
impl ChainSource for GateSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(metadata(0))
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Ok(CoherentDownload {
            metadata: metadata(0),
            chunks: Vec::new(),
            source_block_height: self.source_block,
            source_block_hash: [1; 32],
        })
    }

    async fn events(&self, _cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        Ok(self.batch.clone())
    }
}

fn gate_service(
    batch: EventBatch,
    source_block: u64,
) -> (tempfile::TempDir, IndexerService<GateSource>) {
    let temp = tempfile::tempdir().expect("tempdir");
    let service = IndexerService::new(
        service_config(),
        GateSource {
            batch,
            source_block,
        },
        StateStore::open(&temp.path().join("state.sqlite3")).expect("state"),
        Publisher::open(temp.path().join("artifacts")).expect("publisher"),
        Arc::new(RwLock::new(initial_status())),
    );
    (temp, service)
}

struct FailThenMetadata {
    attempts: Arc<AtomicUsize>,
}

#[async_trait]
impl ChainSource for FailThenMetadata {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        if self.attempts.fetch_add(1, Ordering::SeqCst) < 2 {
            Err(SourceError::Rpc {
                operation: "metadata",
                message: "injected".into(),
            })
        } else {
            Ok(SnapshotMetadata {
                width: WORLD_WIDTH,
                height: WORLD_HEIGHT,
                generation: 0,
                seed: 7,
                population: 0,
                state_digest: decode_digest(DIGEST0),
                chunk_bytes: CHUNK_BYTES as u32,
                chunks_per_row: CHUNKS_PER_ROW,
                max_queue_len: 64,
            })
        }
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        Err(SourceError::Event("download should not run".into()))
    }

    async fn events(&self, _cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        Err(SourceError::Event("events should not run".into()))
    }
}
