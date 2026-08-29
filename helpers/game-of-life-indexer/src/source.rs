use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{StreamExt, TryStreamExt, stream};
use groundhog_contract_util::{NormalizedMethodSignature, contract_entrypoint_id, event_signature};
use groundhog_json_rpc_client::{GroundhogApiClient, HttpClient, HttpClientBuilder};
use groundhog_json_rpc_types::events::{EventPage, EventQuery, IdentifiedEvent};
use groundhog_json_rpc_types::hex::{Hex0x, HexBytes};
use groundhog_json_rpc_types::view::{RootInvocationOutput, ViewRequest, ViewResponse};
use groundhog_xdr::types::{ContractAddress, SHA256Hash};
use serde::{Deserialize, Serialize};

use crate::{CHUNK_BYTES, CHUNK_COUNT, CHUNKS_PER_ROW, ChunkResponse, SnapshotMetadata};

const INTERFACE: &str = "GameOfLife";
const VERSION: &str = "0.1.0";
const CONTRACT_CRATE: &str = "game-of-life";

#[derive(Clone, Debug)]
pub struct SourceConfig {
    pub concurrency: usize,
    pub call_timeout: Duration,
    pub max_attempts: u32,
    pub initial_backoff: Duration,
}

impl Default for SourceConfig {
    fn default() -> Self {
        Self {
            concurrency: 32,
            call_timeout: Duration::from_secs(10),
            max_attempts: 4,
            initial_backoff: Duration::from_millis(100),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CoherentDownload {
    pub metadata: SnapshotMetadata,
    pub chunks: Vec<ChunkResponse>,
    pub source_block_height: u64,
    pub source_block_hash: [u8; 32],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChainEvent {
    pub generation: u64,
    pub seed: Option<u64>,
    pub max_queue_len: Option<u32>,
    pub population: u64,
    pub state_digest: [u8; 32],
    pub block_height: u64,
    pub transaction_hash: String,
    pub event_index: u32,
    pub request_id: Option<String>,
    pub requester: Option<String>,
    pub initialized: bool,
}

#[derive(Clone, Debug, Default)]
pub struct EventBatch {
    pub events: Vec<ChainEvent>,
    pub cursor: Vec<u8>,
    pub exhausted: bool,
    pub latest_block: u64,
    pub oldest_block: u64,
    pub retention_gap: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("build RPC client: {0}")]
    Client(String),
    #[error("RPC {operation} failed after bounded retries: {message}")]
    Rpc {
        operation: &'static str,
        message: String,
    },
    #[error("RPC {operation} timed out after bounded retries")]
    Timeout { operation: &'static str },
    #[error("contract view {0} did not return normally")]
    View(&'static str),
    #[error("decode {0}: {1}")]
    Decode(&'static str, String),
    #[error("mixed-generation quiet-window download: {0}")]
    Mixed(String),
    #[error("event response is malformed: {0}")]
    Event(String),
}

#[async_trait]
pub trait ChainSource: Send + Sync {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError>;
    async fn download(&self) -> Result<CoherentDownload, SourceError>;
    async fn events(&self, cursor: Vec<u8>) -> Result<EventBatch, SourceError>;
}

pub struct GroundhogSource {
    client: Arc<HttpClient>,
    contract: ContractAddress,
    caller: Option<ContractAddress>,
    config: SourceConfig,
}

impl GroundhogSource {
    pub fn new(
        rpc_url: &str,
        contract: ContractAddress,
        caller: Option<ContractAddress>,
        config: SourceConfig,
    ) -> Result<Self, SourceError> {
        if config.concurrency == 0 || config.max_attempts == 0 || config.call_timeout.is_zero() {
            return Err(SourceError::Client(
                "concurrency, timeout, and maximum attempts must be positive".into(),
            ));
        }
        let client = HttpClientBuilder::default()
            .build(rpc_url)
            .map_err(|error| SourceError::Client(error.to_string()))?;
        Ok(Self {
            client: Arc::new(client),
            contract,
            caller,
            config,
        })
    }

    async fn view(
        &self,
        method: &'static str,
        calldata: Vec<u8>,
    ) -> Result<ViewResponse, SourceError> {
        let request = ViewRequest {
            contract: Hex0x(self.contract),
            entrypoint: HexBytes(
                contract_entrypoint_id(
                    Some(INTERFACE),
                    VERSION,
                    &NormalizedMethodSignature::new(method),
                )
                .into_inner()
                .to_vec(),
            ),
            calldata: HexBytes(calldata),
            caller: self.caller.map(Hex0x),
        };
        self.retry(method, || self.client.view(request.clone()))
            .await
    }

    async fn retry<T, F, Fut>(&self, operation: &'static str, mut call: F) -> Result<T, SourceError>
    where
        F: FnMut() -> Fut + Send,
        Fut: std::future::Future<Output = Result<T, jsonrpsee_core::client::Error>> + Send,
        T: Send,
    {
        let mut backoff = self.config.initial_backoff;
        let mut last = None;
        for attempt in 1..=self.config.max_attempts {
            match tokio::time::timeout(self.config.call_timeout, call()).await {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(error)) => {
                    last = Some(SourceError::Rpc {
                        operation,
                        message: error.to_string(),
                    })
                }
                Err(_) => last = Some(SourceError::Timeout { operation }),
            }
            if attempt < self.config.max_attempts {
                tokio::time::sleep(backoff).await;
                backoff = backoff.saturating_mul(2);
            }
        }
        Err(last.unwrap_or(SourceError::Timeout { operation }))
    }

    async fn metadata_response(&self) -> Result<(SnapshotMetadata, i64), SourceError> {
        let response = self.view("get_metadata", encode(&())?).await?;
        let height = *response.height;
        let value: WireMetadata = decode("get_metadata", &response)?;
        Ok((value.into(), height))
    }
}

#[async_trait]
impl ChainSource for GroundhogSource {
    async fn metadata(&self) -> Result<SnapshotMetadata, SourceError> {
        Ok(self.metadata_response().await?.0)
    }

    async fn download(&self) -> Result<CoherentDownload, SourceError> {
        let (before, height) = self.metadata_response().await?;
        before
            .validate()
            .map_err(|error| SourceError::Mixed(error.to_string()))?;
        let source = self;
        let download = stream::iter(0..CHUNK_COUNT as u32)
            .map(|key| async move {
                let row = key / CHUNKS_PER_ROW;
                let part = key % CHUNKS_PER_ROW;
                let response = source.view("get_chunk", encode(&(row, part))?).await?;
                let response_height = *response.height;
                let bytes: [u8; CHUNK_BYTES] = decode("get_chunk", &response)?;
                if response_height != height {
                    return Err(SourceError::Mixed(format!(
                        "chunk {key} used height {response_height}, expected {height}"
                    )));
                }
                Ok(ChunkResponse {
                    row,
                    part,
                    bytes: bytes.to_vec(),
                })
            })
            .buffer_unordered(self.config.concurrency)
            .try_collect::<Vec<_>>();
        let chunks = download.await?;
        let (after, after_height) = self.metadata_response().await?;
        let tip = self.retry("chainTip", || self.client.chain_tip()).await?;
        if height != after_height || height != *tip.height || before != after {
            return Err(SourceError::Mixed(format!(
                "metadata/chaintip mismatch: before={height}, after={after_height}, tip={}",
                *tip.height
            )));
        }
        let source_block_height = u64::try_from(height)
            .map_err(|_| SourceError::Mixed("negative source height".into()))?;
        let source_block_hash: [u8; 32] = tip
            .block_hash
            .as_ref()
            .try_into()
            .map_err(|_| SourceError::Mixed("invalid block hash".into()))?;
        Ok(CoherentDownload {
            metadata: before,
            chunks,
            source_block_height,
            source_block_hash,
        })
    }

    async fn events(&self, cursor: Vec<u8>) -> Result<EventBatch, SourceError> {
        let address = format!("0x{}", hex::encode(self.contract.as_ref()));
        let initial_scan = cursor.is_empty();
        let (anchor, rpc_cursor, resume_height) = decode_resume(&cursor);
        let query: EventQuery = serde_json::from_value(serde_json::json!({
            "filters": [{"contractAddresses": [address], "topics": {"topic0": [], "topic1": [], "topic2": []}}],
            "order": "ascending", "anchor": anchor, "cursor": format!("0x{}", hex::encode(rpc_cursor)), "limit": 200
        })).map_err(|error| SourceError::Event(error.to_string()))?;
        let page: EventPage = self
            .retry("getEvents", || self.client.get_events(query.clone()))
            .await?;
        let events = page
            .events
            .iter()
            .filter_map(decode_life_event)
            .collect::<Result<Vec<_>, _>>()?;
        let latest_block = u64::try_from(*page.latest_block)
            .map_err(|_| SourceError::Event("negative latest event block".into()))?;
        let oldest_block = u64::try_from(*page.oldest_block)
            .map_err(|_| SourceError::Event("negative oldest event block".into()))?;
        let retention_gap = has_retention_gap(initial_scan, resume_height, oldest_block);
        let exhausted = page.cursor.0.is_empty();
        let cursor = if exhausted {
            encode_resume(*page.latest_block)
        } else {
            page.cursor.0
        };
        Ok(EventBatch {
            events,
            cursor,
            exhausted,
            latest_block,
            oldest_block,
            retention_gap,
        })
    }
}

const RESUME_PREFIX: &[u8] = b"life-height:";

fn decode_resume(cursor: &[u8]) -> (serde_json::Value, &[u8], Option<u64>) {
    if let Some(bytes) = cursor.strip_prefix(RESUME_PREFIX)
        && let Ok(bytes) = <[u8; 8]>::try_from(bytes)
    {
        let height = i64::from_be_bytes(bytes);
        return (
            serde_json::json!({"kind": "atHeight", "height": height}),
            &[],
            u64::try_from(height).ok(),
        );
    }
    (serde_json::json!({"kind": "atBeginning"}), cursor, None)
}

fn encode_resume(height: i64) -> Vec<u8> {
    [RESUME_PREFIX, &height.to_be_bytes()].concat()
}

fn has_retention_gap(initial_scan: bool, resume_height: Option<u64>, oldest_block: u64) -> bool {
    resume_height.map_or(initial_scan && oldest_block > 0, |height| {
        height < oldest_block
    })
}

#[derive(Debug, PartialEq, Eq, xdrs::ReadXDR)]
#[xdrs(crate = "::xdrs")]
struct WireMetadata {
    width: u32,
    height: u32,
    generation: u64,
    seed: u64,
    population: u64,
    state_digest: SHA256Hash,
    chunk_bytes: u32,
    chunks_per_row: u32,
    max_queue_len: u32,
}

impl From<WireMetadata> for SnapshotMetadata {
    fn from(value: WireMetadata) -> Self {
        Self {
            width: value.width,
            height: value.height,
            generation: value.generation,
            seed: value.seed,
            population: value.population,
            state_digest: value.state_digest.into_inner(),
            chunk_bytes: value.chunk_bytes,
            chunks_per_row: value.chunks_per_row,
            max_queue_len: value.max_queue_len,
        }
    }
}

fn decode<T: for<'a> xdrs::ReadXDR<'a>>(
    name: &'static str,
    response: &ViewResponse,
) -> Result<T, SourceError> {
    let RootInvocationOutput::Return { return_data } = &response.output else {
        return Err(SourceError::View(name));
    };
    xdrs::cxs::decode(&return_data.0).map_err(|error| SourceError::Decode(name, error.to_string()))
}
fn encode<T: xdrs::WriteXDR>(value: &T) -> Result<Vec<u8>, SourceError> {
    xdrs::cxs::encode(value).map_err(|error| SourceError::Decode("calldata", error.to_string()))
}

fn decode_life_event(event: &IdentifiedEvent) -> Option<Result<ChainEvent, SourceError>> {
    let topic = event.event.topics.first()?.0;
    let initialized = event_signature(VERSION, CONTRACT_CRATE, "WorldInitialized");
    let advanced = event_signature(VERSION, CONTRACT_CRATE, "GenerationAdvanced");
    let tx = format!("0x{}", hex::encode(event.tx_hash.0.as_ref()));
    let block_height = match u64::try_from(*event.block_height) {
        Ok(value) => value,
        Err(_) => return Some(Err(SourceError::Event("negative block height".into()))),
    };
    if topic == initialized {
        if event.event.topics.len() != 1 {
            return Some(Err(SourceError::Event(
                "WorldInitialized must contain only its signature topic".into(),
            )));
        }
        let decoded: Result<(u64, u32, u64, SHA256Hash), _> =
            xdrs::cxs::decode(&event.event.data.0);
        Some(
            decoded
                .map(|(seed, max_queue_len, population, digest)| ChainEvent {
                    generation: 0,
                    seed: Some(seed),
                    max_queue_len: Some(max_queue_len),
                    population,
                    state_digest: digest.into_inner(),
                    block_height,
                    transaction_hash: tx,
                    event_index: event.sequence_number,
                    request_id: None,
                    requester: None,
                    initialized: true,
                })
                .map_err(|error| SourceError::Decode("WorldInitialized event", error.to_string())),
        )
    } else if topic == advanced {
        let Some(request_topic) = event.event.topics.get(1) else {
            return Some(Err(SourceError::Event(
                "GenerationAdvanced is missing its request ID topic".into(),
            )));
        };
        if event.event.topics.len() != 2 {
            return Some(Err(SourceError::Event(
                "GenerationAdvanced has an invalid topic count".into(),
            )));
        }
        let request = format!("0x{}", hex::encode(request_topic.0));
        let decoded: Result<(u64, ContractAddress, u64, SHA256Hash), _> =
            xdrs::cxs::decode(&event.event.data.0);
        Some(
            decoded
                .map(|(generation, requester, population, digest)| ChainEvent {
                    generation,
                    seed: None,
                    max_queue_len: None,
                    population,
                    state_digest: digest.into_inner(),
                    block_height,
                    transaction_hash: tx,
                    event_index: event.sequence_number,
                    request_id: Some(request),
                    requester: Some(format!("0x{}", hex::encode(requester.as_ref()))),
                    initialized: false,
                })
                .map_err(|error| {
                    SourceError::Decode("GenerationAdvanced event", error.to_string())
                }),
        )
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use groundhog_json_rpc_types::BlockHeight;
    use groundhog_json_rpc_types::events::{EmittedEvent, IdentifiedEvent};
    use groundhog_json_rpc_types::hex::{Hex0x, HexBytes, Topic};
    use groundhog_json_rpc_types::transaction::TxHash;

    use super::*;

    #[test]
    fn lifecycle_decoder_requires_exact_topics_and_payloads() {
        let initialized = event_signature(VERSION, CONTRACT_CRATE, "WorldInitialized");
        let initialized_data = xdrs::cxs::encode(&(7u64, 64u32, 9u64, SHA256Hash::from([3; 32])))
            .expect("initialized payload");
        let decoded = decode_life_event(&event(vec![Topic(initialized)], initialized_data))
            .expect("recognized")
            .expect("valid initialized event");
        assert_eq!(decoded.seed, Some(7));
        assert_eq!(decoded.max_queue_len, Some(64));

        assert!(matches!(
            decode_life_event(&event(vec![Topic(initialized), Topic([1; 32])], Vec::new())),
            Some(Err(SourceError::Event(_)))
        ));
        assert!(matches!(
            decode_life_event(&event(vec![Topic(initialized)], vec![1])),
            Some(Err(SourceError::Decode("WorldInitialized event", _)))
        ));
        let mut trailing_initialized =
            xdrs::cxs::encode(&(7u64, 64u32, 9u64, SHA256Hash::from([3; 32])))
                .expect("initialized payload");
        trailing_initialized.push(0);
        assert!(matches!(
            decode_life_event(&event(vec![Topic(initialized)], trailing_initialized)),
            Some(Err(SourceError::Decode("WorldInitialized event", _)))
        ));

        let advanced = event_signature(VERSION, CONTRACT_CRATE, "GenerationAdvanced");
        assert!(matches!(
            decode_life_event(&event(vec![Topic(advanced)], Vec::new())),
            Some(Err(SourceError::Event(_)))
        ));
        assert!(matches!(
            decode_life_event(&event(
                vec![Topic(advanced), Topic([1; 32]), Topic([2; 32])],
                Vec::new()
            )),
            Some(Err(SourceError::Event(_)))
        ));
        assert!(matches!(
            decode_life_event(&event(vec![Topic(advanced), Topic([1; 32])], vec![1])),
            Some(Err(SourceError::Decode("GenerationAdvanced event", _)))
        ));
    }

    #[test]
    fn opaque_pagination_cursor_is_not_an_initial_scan() {
        let cursor = b"opaque server cursor";
        let (_, rpc_cursor, resume_height) = decode_resume(cursor);
        assert_eq!(rpc_cursor, cursor);
        assert_eq!(resume_height, None);
        assert!(!has_retention_gap(false, resume_height, 10));
        assert!(has_retention_gap(true, None, 10));
        assert!(has_retention_gap(false, Some(9), 10));
        assert!(!has_retention_gap(false, Some(10), 10));
    }

    fn event(topics: Vec<Topic>, data: Vec<u8>) -> IdentifiedEvent {
        IdentifiedEvent {
            tx_hash: TxHash(Hex0x(SHA256Hash::from([1; 32]))),
            block_height: BlockHeight::from(1i64),
            sequence_number: 0,
            event: EmittedEvent {
                contract_address: Hex0x(ContractAddress::from([2; 32])),
                topics,
                data: HexBytes(data),
            },
        }
    }
}
