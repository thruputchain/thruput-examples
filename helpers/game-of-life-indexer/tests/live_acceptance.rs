use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use game_of_life_indexer::service::{IndexerService, ServiceConfig, ServiceError, initial_status};
use game_of_life_indexer::source::{GroundhogSource, SourceConfig, SourceError};
use game_of_life_indexer::state::StateStore;
use game_of_life_indexer::storage::Publisher;
use game_of_life_indexer::web::HttpService;
use game_of_life_indexer::{LatestPointer, LifeManifest, LifeProvenance};
use groundhog_xdr::types::ContractAddress;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

#[tokio::test]
#[ignore = "requires an initialized live contract and explicit live acceptance environment"]
async fn indexes_live_generation_and_restarts_byte_identically() {
    let rpc = required("GROUNDHOG_RPC_URL");
    let network_value = required("GROUNDHOG_NETWORK_ID");
    let network = network_value
        .strip_prefix("0x")
        .unwrap_or(&network_value)
        .to_owned();
    let contract_text = required("GROUNDHOG_CONTRACT_ADDRESS");
    let contract = parse_contract(&contract_text);
    let canonical_contract = format!("0x{}", hex::encode(contract.as_ref()));
    let expected_generation: u64 = required("GAME_OF_LIFE_EXPECT_GENERATION")
        .parse()
        .expect("GAME_OF_LIFE_EXPECT_GENERATION must be an integer");
    let root = PathBuf::from(required("GAME_OF_LIFE_ARTIFACT_ROOT"));
    let database = PathBuf::from(required("GAME_OF_LIFE_INDEXER_DB"));
    if let Some(parent) = database.parent() {
        fs::create_dir_all(parent).expect("create SQLite parent");
    }

    let status = Arc::new(RwLock::new(initial_status()));
    let mut service = live_service(
        &rpc,
        contract,
        &network,
        &canonical_contract,
        &root,
        &database,
        Arc::clone(&status),
    );
    publish_when_events_catch_up(&mut service).await;
    drop(service);

    let scope = root
        .join("v1/worlds")
        .join(&network)
        .join(&canonical_contract);
    let latest_bytes = fs::read(scope.join("latest.json")).expect("read latest pointer");
    let latest = LatestPointer::from_json_for(&latest_bytes, &network, &canonical_contract)
        .expect("validate latest pointer");
    assert_eq!(latest.generation, expected_generation.to_string());
    let digest_dir = scope.join(&latest.state_digest);
    let manifest_bytes = fs::read(digest_dir.join("manifest.json")).expect("read manifest");
    let provenance_bytes = fs::read(digest_dir.join("provenance.json")).expect("read provenance");
    let manifest = LifeManifest::from_json(&manifest_bytes).expect("validate manifest");
    let provenance = LifeProvenance::from_json(&provenance_bytes).expect("validate provenance");
    assert_eq!(manifest.generation, latest.generation);
    assert_eq!(manifest.state_digest, latest.state_digest);
    assert_eq!(provenance.generation, latest.generation);
    assert_eq!(provenance.state_digest, latest.state_digest);
    assert_eq!(latest.source_block_height, provenance.source_block_height);
    assert_eq!(latest.source_block_hash, provenance.source_block_hash);

    let state = StateStore::open(&database).expect("open SQLite state");
    let scope_key = format!("{network}:{canonical_contract}");
    assert!(
        state
            .cursor(&scope_key)
            .expect("read event cursor")
            .is_some()
    );
    assert_eq!(
        state
            .evidence(&network, &canonical_contract, &latest.state_digest)
            .expect("read verified evidence"),
        Some(provenance.clone())
    );
    assert!(
        state
            .publication(&network, &canonical_contract, &latest.state_digest)
            .expect("read publication")
            .is_some()
    );
    if expected_generation > 0 {
        let (_, predecessor_digest, _) = state
            .predecessor_publication(&network, &canonical_contract, expected_generation)
            .expect("read predecessor publication")
            .expect("previous generation remains recorded");
        assert!(
            scope.join(predecessor_digest).exists(),
            "previous generation artifacts remain available"
        );
    }
    drop(state);

    let http = HttpService::new(
        root.clone(),
        Arc::clone(&status),
        network.clone(),
        canonical_contract.clone(),
        Vec::<String>::new(),
    );
    for path in [
        format!("/v1/worlds/{network}/{canonical_contract}/latest.json"),
        format!(
            "/v1/worlds/{network}/{canonical_contract}/{}/manifest.json",
            latest.state_digest
        ),
        format!(
            "/v1/worlds/{network}/{canonical_contract}/{}/provenance.json",
            latest.state_digest
        ),
        format!(
            "/v1/worlds/{network}/{canonical_contract}/{}/tiles/0/0/0.bin",
            latest.state_digest
        ),
        format!("/v1/worlds/{network}/{canonical_contract}/status.json"),
    ] {
        let response = http
            .handle(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
            .await;
        assert!(
            response.starts_with(b"HTTP/1.1 200"),
            "HTTP failed for {path}"
        );
    }

    let before_restart = inventory(&scope);
    let mut restarted = live_service(
        &rpc,
        contract,
        &network,
        &canonical_contract,
        &root,
        &database,
        Arc::new(RwLock::new(initial_status())),
    );
    restarted.cycle().await.expect("restart fast path");
    drop(restarted);
    assert_eq!(inventory(&scope), before_restart);
}

fn live_service(
    rpc: &str,
    contract: ContractAddress,
    network: &str,
    canonical_contract: &str,
    root: &Path,
    database: &Path,
    status: Arc<RwLock<game_of_life_indexer::LifeStatus>>,
) -> IndexerService<GroundhogSource> {
    IndexerService::new(
        ServiceConfig {
            network_id: network.to_owned(),
            contract_address: canonical_contract.to_owned(),
            poll_interval: Duration::from_millis(250),
            retention_grace: Duration::from_secs(300),
            max_retry_backoff: Duration::from_secs(5),
        },
        GroundhogSource::new(rpc, contract, None, SourceConfig::default()).expect("RPC source"),
        StateStore::open(database).expect("SQLite state"),
        Publisher::open(root.to_owned()).expect("artifact publisher"),
        status,
    )
}

async fn publish_when_events_catch_up(service: &mut IndexerService<GroundhogSource>) {
    tokio::time::timeout(Duration::from_secs(600), async {
        loop {
            match service.cycle().await {
                Ok(()) => return,
                Err(ServiceError::EventIndexBehind { .. })
                | Err(ServiceError::Source(SourceError::Mixed(_))) => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                Err(error) => panic!("live indexing failed: {error}"),
            }
        }
    })
    .await
    .expect("live indexing exceeded ten minutes");
}

fn inventory(root: &Path) -> Vec<(PathBuf, u64, [u8; 32])> {
    fn visit(root: &Path, path: &Path, files: &mut Vec<(PathBuf, u64, [u8; 32])>) {
        let mut entries = fs::read_dir(path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
            .collect::<Result<Vec<_>, _>>()
            .expect("read directory entry");
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if entry.file_type().expect("file type").is_dir() {
                visit(root, &path, files);
            } else {
                let bytes = fs::read(&path)
                    .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
                files.push((
                    path.strip_prefix(root).expect("relative path").to_owned(),
                    bytes.len() as u64,
                    Sha256::digest(bytes).into(),
                ));
            }
        }
    }

    let mut files = Vec::new();
    visit(root, root, &mut files);
    files
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn parse_contract(value: &str) -> ContractAddress {
    let bytes = hex::decode(value.strip_prefix("0x").unwrap_or(value)).expect("contract hex");
    ContractAddress::from(<[u8; 32]>::try_from(bytes).expect("contract must be 32 bytes"))
}
