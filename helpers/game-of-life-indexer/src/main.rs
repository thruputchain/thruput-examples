use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use game_of_life_indexer::service::{IndexerService, ServiceConfig, initial_status};
use game_of_life_indexer::source::{GroundhogSource, SourceConfig};
use game_of_life_indexer::state::StateStore;
use game_of_life_indexer::storage::Publisher;
use game_of_life_indexer::web::{HttpService, heartbeat};
use groundhog_xdr::types::ContractAddress;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let rpc = required("GROUNDHOG_RPC_URL")?;
    let network = normalize_network(&required("GROUNDHOG_NETWORK_ID")?)?;
    let contract_text = required("GROUNDHOG_CONTRACT_ADDRESS")?;
    let contract = parse_address(&contract_text)?;
    let root = PathBuf::from(
        std::env::var("GAME_OF_LIFE_ARTIFACT_ROOT")
            .unwrap_or_else(|_| "tmp/game-of-life-indexer/artifacts".into()),
    );
    let database = PathBuf::from(
        std::env::var("GAME_OF_LIFE_INDEXER_DB")
            .unwrap_or_else(|_| "tmp/game-of-life-indexer/indexer.sqlite3".into()),
    );
    if let Some(parent) = database.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listen: SocketAddr = std::env::var("GAME_OF_LIFE_INDEXER_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()?;
    if !listen.ip().is_loopback() {
        return Err(format!("indexer listener must be loopback: {listen}").into());
    }
    let origins = std::env::var("GAME_OF_LIFE_CORS_ORIGINS")
        .unwrap_or_else(|_| "http://127.0.0.1:5173,http://localhost:5173".into())
        .split(',')
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let retention_grace = positive_seconds(
        "GAME_OF_LIFE_RETENTION_GRACE_SECONDS",
        std::env::var("GAME_OF_LIFE_RETENTION_GRACE_SECONDS").ok(),
        300,
    )?;

    let publisher = Publisher::open(root.clone())?;
    let state = StateStore::open(&database)?;
    let source = GroundhogSource::new(&rpc, contract, None, SourceConfig::default())?;
    let status = Arc::new(RwLock::new(initial_status()));
    let contract_address = canonical_address(&contract);
    let service = IndexerService::new(
        ServiceConfig {
            network_id: network.clone(),
            contract_address: contract_address.clone(),
            poll_interval: Duration::from_secs(10),
            retention_grace,
            max_retry_backoff: Duration::from_secs(300),
        },
        source,
        state,
        publisher,
        Arc::clone(&status),
    );
    let http = Arc::new(HttpService::new(
        root,
        Arc::clone(&status),
        network,
        contract_address,
        origins,
    ));
    tokio::spawn(heartbeat(status));
    tokio::select! {
        result = service.run() => result.map_err(|error| error.into()),
        result = http.serve(listen) => result.map_err(|error| error.into()),
        result = tokio::signal::ctrl_c() => result.map_err(|error| error.into()),
    }
}

fn required(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is required"))
}
fn normalize_network(value: &str) -> Result<String, String> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(value.into())
    } else {
        Err("GROUNDHOG_NETWORK_ID must be 32 lowercase hex bytes".into())
    }
}
fn parse_address(value: &str) -> Result<ContractAddress, String> {
    if value.len() != 66
        || !value.starts_with("0x")
        || !value[2..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "GROUNDHOG_CONTRACT_ADDRESS must be canonical lowercase 0x-prefixed 32-byte hex".into(),
        );
    }
    let bytes = hex::decode(&value[2..]).map_err(|error| error.to_string())?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "contract address must be 32 bytes")?;
    Ok(ContractAddress::from(bytes))
}
fn canonical_address(value: &ContractAddress) -> String {
    format!("0x{}", hex::encode(value.as_ref()))
}

fn positive_seconds(name: &str, value: Option<String>, default: u64) -> Result<Duration, String> {
    let seconds = value.map_or(Ok(default), |value| {
        value
            .parse::<u64>()
            .map_err(|_| format!("{name} must be a positive integer"))
    })?;
    if seconds == 0 || seconds > i64::MAX as u64 {
        return Err(format!(
            "{name} must be a positive integer no greater than {}",
            i64::MAX
        ));
    }
    Ok(Duration::from_secs(seconds))
}

#[cfg(test)]
mod tests {
    use super::{parse_address, positive_seconds};

    #[test]
    fn retention_grace_uses_default_and_accepts_positive_values() {
        assert_eq!(
            positive_seconds("RETENTION", None, 300)
                .expect("default")
                .as_secs(),
            300
        );
        assert_eq!(
            positive_seconds("RETENTION", Some("45".into()), 300)
                .expect("configured")
                .as_secs(),
            45
        );
    }

    #[test]
    fn retention_grace_rejects_zero_and_invalid_values() {
        assert!(positive_seconds("RETENTION", Some("0".into()), 300).is_err());
        assert!(positive_seconds("RETENTION", Some("later".into()), 300).is_err());
        assert!(positive_seconds("RETENTION", Some(u64::MAX.to_string()), 300).is_err());
    }

    #[test]
    fn contract_address_requires_canonical_lowercase_prefixed_hex() {
        let canonical = format!("0x{}", "ab".repeat(32));
        assert!(parse_address(&canonical).is_ok());
        assert!(parse_address(&canonical[2..]).is_err());
        assert!(parse_address(&canonical.to_uppercase()).is_err());
        assert!(parse_address(&format!("0x{}", "AB".repeat(32))).is_err());
        assert!(parse_address("0x01").is_err());
    }
}
