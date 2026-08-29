use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{CELL_COUNT, Error, MAX_ZOOM, Result, TILE_SIZE, WORLD_HEIGHT, WORLD_WIDTH};

const TILE_TEMPLATE: &str = "tiles/{z}/{x}/{y}.bin";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verification {
    pub canonical_download_verified: bool,
    pub individual_tile_proofs: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeManifest {
    pub schema_version: u8,
    pub network_id: String,
    pub contract_address: String,
    pub generation: String,
    pub seed: String,
    pub width: u32,
    pub height: u32,
    pub population: String,
    pub state_digest: String,
    pub tile_size: u32,
    pub max_zoom: u8,
    pub density_encoding: String,
    pub cell_encoding: String,
    pub tile_path_template: String,
    pub verification: Verification,
}

impl LifeManifest {
    pub fn new(identity: &SnapshotIdentity) -> Self {
        Self {
            schema_version: 1,
            network_id: identity.network_id.clone(),
            contract_address: identity.contract_address.clone(),
            generation: identity.generation.to_string(),
            seed: identity.seed.to_string(),
            width: WORLD_WIDTH,
            height: WORLD_HEIGHT,
            population: identity.population.to_string(),
            state_digest: hex32(&identity.state_digest),
            tile_size: TILE_SIZE,
            max_zoom: MAX_ZOOM,
            density_encoding: "u16le-live-count".into(),
            cell_encoding: "row-major-lsb-first".into(),
            tile_path_template: TILE_TEMPLATE.into(),
            verification: Verification {
                canonical_download_verified: true,
                individual_tile_proofs: false,
            },
        }
    }

    pub fn validate(&self) -> Result<()> {
        require(self.schema_version == 1, "schemaVersion", "must be 1")?;
        validate_network_id(&self.network_id)?;
        validate_hex32("contractAddress", &self.contract_address)?;
        parse_u64("generation", &self.generation)?;
        parse_u64("seed", &self.seed)?;
        parse_population(&self.population)?;
        validate_hex32("stateDigest", &self.state_digest)?;
        require(self.width == WORLD_WIDTH, "width", "unsupported width")?;
        require(self.height == WORLD_HEIGHT, "height", "unsupported height")?;
        require(
            self.tile_size == TILE_SIZE,
            "tileSize",
            "unsupported tile size",
        )?;
        require(
            self.max_zoom == MAX_ZOOM,
            "maxZoom",
            "unsupported maximum zoom",
        )?;
        require(
            self.density_encoding == "u16le-live-count",
            "densityEncoding",
            "unsupported encoding",
        )?;
        require(
            self.cell_encoding == "row-major-lsb-first",
            "cellEncoding",
            "unsupported encoding",
        )?;
        require(
            self.tile_path_template == TILE_TEMPLATE,
            "tilePathTemplate",
            "must be the confined version-one template",
        )?;
        require(
            self.verification.canonical_download_verified,
            "verification.canonicalDownloadVerified",
            "must be true",
        )?;
        require(
            !self.verification.individual_tile_proofs,
            "verification.individualTileProofs",
            "must be false",
        )
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        parse_validated(bytes, Self::validate)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotIdentity {
    pub network_id: String,
    pub contract_address: String,
    pub generation: u64,
    pub seed: u64,
    pub population: u64,
    pub state_digest: [u8; 32],
}

impl SnapshotIdentity {
    pub fn validate(&self) -> Result<()> {
        validate_network_id(&self.network_id)?;
        validate_hex32("contractAddress", &self.contract_address)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceKind {
    MetadataObservation,
    WorldInitializedEvent,
    GenerationAdvancedEvent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    WorldInitialized,
    GenerationAdvanced,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeProvenance {
    pub schema_version: u8,
    pub network_id: String,
    pub contract_address: String,
    pub generation: String,
    pub seed: String,
    pub population: String,
    pub state_digest: String,
    pub source_block_height: String,
    pub source_block_hash: String,
    pub evidence_kind: EvidenceKind,
    pub transaction_hash: Option<String>,
    pub event_index: Option<u32>,
    pub event_kind: Option<EventKind>,
    pub request_id: Option<String>,
    pub requester: Option<String>,
    pub verified_at: String,
}

impl LifeProvenance {
    pub fn validate(&self) -> Result<()> {
        require(self.schema_version == 1, "schemaVersion", "must be 1")?;
        validate_network_id(&self.network_id)?;
        validate_hex32("contractAddress", &self.contract_address)?;
        parse_u64("seed", &self.seed)?;
        let generation = parse_u64("generation", &self.generation)?;
        parse_population(&self.population)?;
        validate_hex32("stateDigest", &self.state_digest)?;
        parse_u64("sourceBlockHeight", &self.source_block_height)?;
        validate_hex32("sourceBlockHash", &self.source_block_hash)?;
        validate_timestamp("verifiedAt", &self.verified_at)?;

        match self.evidence_kind {
            EvidenceKind::MetadataObservation => require(
                self.transaction_hash.is_none()
                    && self.event_index.is_none()
                    && self.event_kind.is_none()
                    && self.request_id.is_none()
                    && self.requester.is_none(),
                "evidence",
                "metadata observation cannot contain event fields",
            ),
            EvidenceKind::WorldInitializedEvent => {
                require(
                    generation == 0,
                    "generation",
                    "WorldInitialized evidence requires generation 0",
                )?;
                validate_event_common(self, EventKind::WorldInitialized)?;
                require(
                    self.request_id.is_none() && self.requester.is_none(),
                    "evidence",
                    "initialization cannot contain request fields",
                )
            }
            EvidenceKind::GenerationAdvancedEvent => {
                require(
                    generation > 0,
                    "generation",
                    "GenerationAdvanced evidence requires generation greater than 0",
                )?;
                validate_event_common(self, EventKind::GenerationAdvanced)?;
                validate_hex32("requestId", required(&self.request_id, "requestId")?)?;
                validate_hex32("requester", required(&self.requester, "requester")?)
            }
        }
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        parse_validated(bytes, Self::validate)
    }

    pub(crate) fn matches(&self, identity: &SnapshotIdentity) -> bool {
        self.network_id == identity.network_id
            && self.contract_address == identity.contract_address
            && self.generation == identity.generation.to_string()
            && self.seed == identity.seed.to_string()
            && self.population == identity.population.to_string()
            && self.state_digest == hex32(&identity.state_digest)
    }
}

fn validate_event_common(value: &LifeProvenance, expected: EventKind) -> Result<()> {
    validate_hex32(
        "transactionHash",
        required(&value.transaction_hash, "transactionHash")?,
    )?;
    required(&value.event_index, "eventIndex")?;
    require(
        value.event_kind == Some(expected),
        "eventKind",
        "does not match evidence kind",
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LatestPointer {
    pub schema_version: u8,
    pub generation: String,
    pub state_digest: String,
    pub manifest_url: String,
    pub source_block_height: String,
    pub source_block_hash: String,
    pub published_at: String,
}

impl LatestPointer {
    pub fn validate(&self) -> Result<()> {
        self.validate_fields()?;
        validate_relative_manifest_url(&self.manifest_url, &self.state_digest)
    }

    pub fn validate_for(&self, network_id: &str, contract_address: &str) -> Result<()> {
        self.validate_fields()?;
        validate_network_id(network_id)?;
        validate_hex32("contractAddress", contract_address)?;
        let expected = format!(
            "/v1/worlds/{network_id}/{contract_address}/{}/manifest.json",
            self.state_digest
        );
        require(
            self.manifest_url == expected,
            "manifestUrl",
            "must exactly match the canonical pointer scope",
        )
    }

    fn validate_fields(&self) -> Result<()> {
        require(self.schema_version == 1, "schemaVersion", "must be 1")?;
        parse_u64("generation", &self.generation)?;
        validate_hex32("stateDigest", &self.state_digest)?;
        parse_u64("sourceBlockHeight", &self.source_block_height)?;
        validate_hex32("sourceBlockHash", &self.source_block_hash)?;
        validate_timestamp("publishedAt", &self.published_at)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        parse_validated(bytes, Self::validate)
    }

    pub fn from_json_for(bytes: &[u8], network_id: &str, contract_address: &str) -> Result<Self> {
        let value: Self =
            serde_json::from_slice(bytes).map_err(|error| Error::Json(error.to_string()))?;
        value.validate_for(network_id, contract_address)?;
        Ok(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexerState {
    Idle,
    Preparing,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedIdentity {
    pub generation: String,
    pub state_digest: String,
}

impl PublishedIdentity {
    fn validate(&self) -> Result<()> {
        parse_u64("generation", &self.generation)?;
        validate_hex32("stateDigest", &self.state_digest)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProgressUnit {
    Chunks,
    Tiles,
    Files,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub generation: String,
    pub state_digest: String,
    pub completed_units: u32,
    pub total_units: u32,
    pub unit: ProgressUnit,
}

impl Progress {
    fn validate(&self) -> Result<()> {
        PublishedIdentity {
            generation: self.generation.clone(),
            state_digest: self.state_digest.clone(),
        }
        .validate()?;
        require(self.total_units > 0, "totalUnits", "must be positive")?;
        require(
            self.completed_units <= self.total_units,
            "completedUnits",
            "cannot exceed totalUnits",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retry {
    pub attempt: u32,
    pub next_at: String,
}

impl Retry {
    fn validate(&self) -> Result<()> {
        require(self.attempt > 0, "retry.attempt", "must be positive")?;
        validate_timestamp("retry.nextAt", &self.next_at)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeStatus {
    pub schema_version: u8,
    pub state: IndexerState,
    pub observed: Option<PublishedIdentity>,
    pub preparing: Option<Progress>,
    pub published: Option<PublishedIdentity>,
    pub retry: Option<Retry>,
    pub error_code: Option<String>,
    pub heartbeat_at: String,
}

impl LifeStatus {
    pub fn validate(&self) -> Result<()> {
        require(self.schema_version == 1, "schemaVersion", "must be 1")?;
        if let Some(value) = &self.observed {
            value.validate()?;
        }
        if let Some(value) = &self.preparing {
            value.validate()?;
        }
        if let Some(value) = &self.published {
            value.validate()?;
        }
        if let Some(value) = &self.retry {
            value.validate()?;
        }
        validate_timestamp("heartbeatAt", &self.heartbeat_at)?;
        require(
            (self.state == IndexerState::Preparing) == self.preparing.is_some(),
            "preparing",
            "must be present exactly in preparing state",
        )?;
        require(
            (self.state == IndexerState::Error) == self.error_code.is_some(),
            "errorCode",
            "must be present exactly in error state",
        )?;
        if let Some(code) = &self.error_code {
            require(
                !code.is_empty()
                    && code.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    }),
                "errorCode",
                "must use nonempty uppercase snake case",
            )?;
        }
        Ok(())
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        parse_validated(bytes, Self::validate)
    }
}

pub(crate) fn compact_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|error| Error::Json(error.to_string()))
}

fn parse_validated<T: DeserializeOwned>(bytes: &[u8], validate: fn(&T) -> Result<()>) -> Result<T> {
    let value = serde_json::from_slice(bytes).map_err(|error| Error::Json(error.to_string()))?;
    validate(&value)?;
    Ok(value)
}

fn validate_network_id(value: &str) -> Result<()> {
    require(
        value.len() == 64 && value.bytes().all(is_lower_hex),
        "networkId",
        "must be 64 lowercase hexadecimal characters without 0x",
    )
}

fn validate_hex32(field: &'static str, value: &str) -> Result<()> {
    require(
        value.len() == 66 && value.starts_with("0x") && value[2..].bytes().all(is_lower_hex),
        field,
        "must be canonical lowercase 0x-prefixed 32-byte hexadecimal",
    )
}

fn validate_relative_manifest_url(value: &str, digest: &str) -> Result<()> {
    require(
        value == format!("{digest}/manifest.json"),
        "manifestUrl",
        "must be the canonical digest-relative manifest path",
    )
}

fn validate_timestamp(field: &'static str, value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    let shape_is_valid = bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes.last() == Some(&b'Z')
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[17..19].iter().all(u8::is_ascii_digit)
        && (bytes.len() == 20
            || bytes[19] == b'.'
                && bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit)
                && bytes.len() > 21);
    require(shape_is_valid, field, "must be a UTC RFC 3339 timestamp")?;

    let year = decimal(&bytes[..4]);
    let month = decimal(&bytes[5..7]);
    let day = decimal(&bytes[8..10]);
    let hour = decimal(&bytes[11..13]);
    let minute = decimal(&bytes[14..16]);
    let second = decimal(&bytes[17..19]);
    let leap_year =
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => 0,
    };
    require(
        (1..=days_in_month).contains(&day) && hour < 24 && minute < 60 && second < 60,
        field,
        "must contain a valid UTC date and time",
    )
}

fn decimal(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0, |value, byte| value * 10 + u32::from(byte - b'0'))
}

fn parse_u64(field: &'static str, value: &str) -> Result<u64> {
    require(
        value == "0" || !value.starts_with('0'),
        field,
        "must be a canonical decimal u64",
    )?;
    value.parse().map_err(|_| Error::Schema {
        field,
        reason: "must be a canonical decimal u64",
    })
}

fn parse_population(value: &str) -> Result<u64> {
    let population = parse_u64("population", value)?;
    require(
        population <= CELL_COUNT,
        "population",
        "cannot exceed the world cell count",
    )?;
    Ok(population)
}

fn required<'a, T>(value: &'a Option<T>, field: &'static str) -> Result<&'a T> {
    value.as_ref().ok_or(Error::Schema {
        field,
        reason: "is required",
    })
}

fn require(condition: bool, field: &'static str, reason: &'static str) -> Result<()> {
    condition
        .then_some(())
        .ok_or(Error::Schema { field, reason })
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn hex32(value: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(value))
}
