use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;

use crate::schema::EvidenceKind;
use crate::source::{ChainEvent, ChainSource, CoherentDownload, SourceError};
use crate::state::{StateError, StateStore};
use crate::storage::{Publisher, StorageError};
use crate::{
    EventKind as PublicEventKind, IndexerState, LatestPointer, LifeProvenance, LifeStatus,
    Progress, ProgressUnit, PublishedIdentity, build_snapshot,
};

#[derive(Clone, Debug)]
pub struct ServiceConfig {
    pub network_id: String,
    pub contract_address: String,
    pub poll_interval: Duration,
    pub retention_grace: Duration,
    pub max_retry_backoff: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error(transparent)]
    Source(#[from] SourceError),
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Snapshot(#[from] crate::Error),
    #[error("event history has a retention gap (oldest retained block {oldest_block})")]
    EventRetentionGap { oldest_block: u64 },
    #[error(
        "event index is caught through block {latest_block}, before source block {source_block}"
    )]
    EventIndexBehind {
        latest_block: u64,
        source_block: u64,
    },
    #[error("no valid committed lifecycle event matches generation {generation}")]
    MissingLifecycleEvidence { generation: u64 },
    #[error("injected service interruption at {0:?}")]
    Injected(FailurePoint),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailurePoint {
    AfterDownload,
    BeforeBuild,
    BeforeArtifacts,
    AfterArtifacts,
    AfterPromotion,
}

const TILE_COUNT: u32 = 2_139;

pub struct IndexerService<S> {
    config: ServiceConfig,
    source: S,
    state: StateStore,
    publisher: Publisher,
    status: Arc<RwLock<LifeStatus>>,
    events: Vec<ChainEvent>,
    pending: Option<CoherentDownload>,
    latest_publication: Option<LatestPointer>,
    publication_reconciled: bool,
    retry_attempt: u32,
    failure_point: Option<FailurePoint>,
}

impl<S: ChainSource> IndexerService<S> {
    pub fn new(
        config: ServiceConfig,
        source: S,
        state: StateStore,
        publisher: Publisher,
        status: Arc<RwLock<LifeStatus>>,
    ) -> Self {
        Self {
            config,
            source,
            state,
            publisher,
            status,
            events: Vec::new(),
            pending: None,
            latest_publication: None,
            publication_reconciled: false,
            retry_attempt: 0,
            failure_point: None,
        }
    }

    #[doc(hidden)]
    pub fn inject_failure(&mut self, point: FailurePoint) {
        self.failure_point = Some(point);
    }

    pub async fn run(mut self) -> Result<(), ServiceError> {
        loop {
            let delay = self.step().await;
            tokio::time::sleep(delay).await;
        }
    }

    #[doc(hidden)]
    pub async fn step(&mut self) -> Duration {
        match self.cycle().await {
            Ok(()) => {
                self.retry_attempt = 0;
                self.config.poll_interval
            }
            Err(error) => {
                self.retry_attempt = self.retry_attempt.saturating_add(1);
                let delay = retry_delay(
                    self.retry_attempt,
                    self.config.poll_interval,
                    self.config.max_retry_backoff,
                );
                let mut status = self.status.write().await;
                status.state = IndexerState::Error;
                status.preparing = None;
                status.error_code = Some(error_code(&error).into());
                status.retry = Some(crate::Retry {
                    attempt: self.retry_attempt,
                    next_at: timestamp_after(delay),
                });
                delay
            }
        }
    }

    pub async fn cycle(&mut self) -> Result<(), ServiceError> {
        let cycle_started = std::time::Instant::now();
        if !self.publication_reconciled {
            self.reconcile_publication().await?;
        }
        let latest = self.latest_publication.clone();
        if self.pending.is_none() {
            let observed = self.source.metadata().await?;
            let digest = hex32(&observed.state_digest);
            if latest.is_some_and(|latest| {
                latest.generation == observed.generation.to_string()
                    && latest.state_digest == digest
            }) {
                self.cleanup()?;
                let mut status = self.status.write().await;
                status.observed = Some(identity(observed.generation, &digest));
                status.published = Some(identity(observed.generation, &digest));
                status.state = IndexerState::Idle;
                status.preparing = None;
                status.error_code = None;
                status.retry = None;
                return Ok(());
            }
            self.set_preparing(
                &observed,
                &digest,
                0,
                crate::CHUNK_COUNT as u32,
                ProgressUnit::Chunks,
            )
            .await;
            let download_started = std::time::Instant::now();
            let download = self.source.download().await?;
            eprintln!(
                "game_of_life_indexer_metric stage=download generation={} elapsed_ms={}",
                observed.generation,
                download_started.elapsed().as_millis()
            );
            if download.metadata != observed {
                return Err(SourceError::Mixed(
                    "poll observation changed before quiet-window acquisition".into(),
                )
                .into());
            }
            self.pending = Some(download);
        }
        let pending = self.pending.as_ref().ok_or_else(|| {
            SourceError::Mixed("pending download disappeared before processing".into())
        })?;
        let metadata = pending.metadata.clone();
        let source_block_height = pending.source_block_height;
        let source_block_hash = pending.source_block_hash;
        let digest = hex32(&metadata.state_digest);
        self.set_preparing(
            &metadata,
            &digest,
            crate::CHUNK_COUNT as u32,
            crate::CHUNK_COUNT as u32,
            ProgressUnit::Chunks,
        )
        .await;
        self.fail_if(FailurePoint::AfterDownload)?;
        self.observe_events_through(source_block_height).await?;
        let candidate = self.provenance(&metadata, source_block_height, source_block_hash)?;
        let provenance = self
            .state
            .resolve_evidence(&candidate)?
            .unwrap_or(candidate);
        self.set_preparing(&metadata, &digest, 0, TILE_COUNT, ProgressUnit::Tiles)
            .await;
        self.fail_if(FailurePoint::BeforeBuild)?;
        let download = self.pending.take().ok_or_else(|| {
            SourceError::Mixed("pending download disappeared before verification".into())
        })?;
        let build_started = std::time::Instant::now();
        let snapshot = build_snapshot(
            &download.metadata,
            self.config.network_id.clone(),
            self.config.contract_address.clone(),
            download.chunks,
            provenance.clone(),
        )?;
        let generated_bytes = snapshot
            .artifacts
            .iter()
            .map(|artifact| artifact.bytes.len() as u64)
            .sum::<u64>();
        eprintln!(
            "game_of_life_indexer_metric stage=build generation={} elapsed_ms={} generated_bytes={generated_bytes}",
            metadata.generation,
            build_started.elapsed().as_millis()
        );
        let artifact_count =
            u32::try_from(snapshot.artifacts.len()).map_err(|_| crate::Error::Schema {
                field: "artifacts",
                reason: "artifact count exceeds status capacity",
            })?;
        self.set_preparing(&metadata, &digest, 0, artifact_count, ProgressUnit::Files)
            .await;
        let provenance = self.state.persist_evidence(&provenance)?;
        self.fail_if(FailurePoint::BeforeArtifacts)?;
        let publication_started = std::time::Instant::now();
        self.publisher.publish_snapshot(
            &self.config.network_id,
            &self.config.contract_address,
            &digest,
            &snapshot.artifacts,
        )?;
        self.fail_if(FailurePoint::AfterArtifacts)?;
        let pointer = LatestPointer {
            schema_version: 1,
            generation: metadata.generation.to_string(),
            state_digest: digest.clone(),
            manifest_url: format!(
                "/v1/worlds/{}/{}/{digest}/manifest.json",
                self.config.network_id, self.config.contract_address
            ),
            source_block_height: provenance.source_block_height.clone(),
            source_block_hash: provenance.source_block_hash.clone(),
            published_at: now(),
        };
        // Promotion can become visible before a final directory sync reports failure.
        self.publication_reconciled = false;
        self.publisher.promote(
            &self.config.network_id,
            &self.config.contract_address,
            &pointer,
        )?;
        self.fail_if(FailurePoint::AfterPromotion)?;
        self.reconcile_publication().await?;
        eprintln!(
            "game_of_life_indexer_metric stage=publication generation={} elapsed_ms={} total_ms={}",
            metadata.generation,
            publication_started.elapsed().as_millis(),
            cycle_started.elapsed().as_millis()
        );
        self.cleanup()?;
        let mut status = self.status.write().await;
        status.state = IndexerState::Idle;
        status.preparing = None;
        status.published = Some(identity(metadata.generation, &digest));
        status.error_code = None;
        status.retry = None;
        Ok(())
    }

    async fn set_preparing(
        &self,
        metadata: &crate::SnapshotMetadata,
        digest: &str,
        completed_units: u32,
        total_units: u32,
        unit: ProgressUnit,
    ) {
        let mut status = self.status.write().await;
        status.observed = Some(identity(metadata.generation, digest));
        status.state = IndexerState::Preparing;
        status.preparing = Some(Progress {
            generation: metadata.generation.to_string(),
            state_digest: digest.to_owned(),
            completed_units,
            total_units,
            unit,
        });
        status.error_code = None;
        status.retry = None;
    }

    fn cleanup(&self) -> Result<(), ServiceError> {
        let grace = chrono::Utc::now()
            .timestamp()
            .saturating_sub(self.config.retention_grace.as_secs() as i64);
        let retained = self.state.retained_digests(
            &self.config.network_id,
            &self.config.contract_address,
            grace,
        )?;
        self.publisher.cleanup(
            &self.config.network_id,
            &self.config.contract_address,
            &retained,
        )?;
        Ok(())
    }

    async fn observe_events_through(&mut self, source_block: u64) -> Result<(), ServiceError> {
        let scope = format!(
            "{}:{}",
            self.config.network_id, self.config.contract_address
        );
        let mut cursor = self.state.cursor(&scope)?.unwrap_or_default();
        for _ in 0..10_000 {
            let batch = self.source.events(cursor.clone()).await?;
            if batch.retention_gap {
                return Err(ServiceError::EventRetentionGap {
                    oldest_block: batch.oldest_block,
                });
            }
            if batch.cursor == cursor && !batch.exhausted {
                return Err(
                    SourceError::Event("event pagination repeated its cursor".into()).into(),
                );
            }
            self.state
                .save_event_batch(&scope, &batch.events, &batch.cursor)?;
            cursor = batch.cursor;
            if batch.exhausted {
                if batch.latest_block < source_block {
                    return Err(ServiceError::EventIndexBehind {
                        latest_block: batch.latest_block,
                        source_block,
                    });
                }
                self.events = self.state.chain_events(&scope)?;
                self.events
                    .sort_by_key(|event| (event.generation, event.event_index));
                return Ok(());
            }
        }
        Err(SourceError::Event("event pagination exceeded 10000 pages".into()).into())
    }

    fn provenance(
        &self,
        metadata: &crate::SnapshotMetadata,
        height: u64,
        hash: [u8; 32],
    ) -> Result<LifeProvenance, ServiceError> {
        let event = self.events.iter().rev().find(|event| {
            let event_specific_match = if metadata.generation == 0 {
                event.initialized
                    && event.seed == Some(metadata.seed)
                    && event.max_queue_len == Some(metadata.max_queue_len)
                    && event.request_id.is_none()
                    && event.requester.is_none()
            } else {
                !event.initialized
                    && event.seed.is_none()
                    && event.max_queue_len.is_none()
                    && event.request_id.is_some()
                    && event.requester.is_some()
            };
            event.generation == metadata.generation
                && event.population == metadata.population
                && event.state_digest == metadata.state_digest
                && event.block_height <= height
                && event_specific_match
        });
        let (evidence_kind, transaction_hash, event_index, event_kind, request_id, requester) =
            match event {
                Some(event) if event.initialized => (
                    EvidenceKind::WorldInitializedEvent,
                    Some(event.transaction_hash.clone()),
                    Some(event.event_index),
                    Some(PublicEventKind::WorldInitialized),
                    None,
                    None,
                ),
                Some(event) => (
                    EvidenceKind::GenerationAdvancedEvent,
                    Some(event.transaction_hash.clone()),
                    Some(event.event_index),
                    Some(PublicEventKind::GenerationAdvanced),
                    event.request_id.clone(),
                    event.requester.clone(),
                ),
                None => {
                    return Err(ServiceError::MissingLifecycleEvidence {
                        generation: metadata.generation,
                    });
                }
            };
        Ok(LifeProvenance {
            schema_version: 1,
            network_id: self.config.network_id.clone(),
            contract_address: self.config.contract_address.clone(),
            generation: metadata.generation.to_string(),
            seed: metadata.seed.to_string(),
            population: metadata.population.to_string(),
            state_digest: hex32(&metadata.state_digest),
            source_block_height: height.to_string(),
            source_block_hash: hex32(&hash),
            evidence_kind,
            transaction_hash,
            event_index,
            event_kind,
            request_id,
            requester,
            verified_at: now(),
        })
    }

    async fn reconcile_publication(&mut self) -> Result<Option<LatestPointer>, ServiceError> {
        let latest = self
            .publisher
            .latest(&self.config.network_id, &self.config.contract_address)?;
        let Some(latest) = latest else {
            self.latest_publication = None;
            self.publication_reconciled = true;
            return Ok(None);
        };
        let current_generation: u64 =
            latest
                .generation
                .parse()
                .map_err(|_| crate::Error::Schema {
                    field: "generation",
                    reason: "latest generation is invalid",
                })?;
        let promoted_at = chrono::DateTime::parse_from_rfc3339(&latest.published_at)
            .map_err(|_| crate::Error::Schema {
                field: "publishedAt",
                reason: "latest publication timestamp is invalid",
            })?
            .timestamp();
        let ready = self
            .publisher
            .ready_identities(&self.config.network_id, &self.config.contract_address)?;
        let mut publications = vec![(current_generation, latest.state_digest.clone(), promoted_at)];
        let recorded_predecessor = self.state.predecessor_publication(
            &self.config.network_id,
            &self.config.contract_address,
            current_generation,
        )?;
        let predecessor = recorded_predecessor
            .filter(|(generation, digest, _)| {
                ready.iter().any(|identity| {
                    identity.generation == *generation && identity.state_digest == *digest
                })
            })
            .or_else(|| {
                ready
                    .iter()
                    .filter(|identity| identity.generation < current_generation)
                    .max_by_key(|identity| identity.generation)
                    .map(|identity| {
                        (
                            identity.generation,
                            identity.state_digest.clone(),
                            promoted_at,
                        )
                    })
            });
        if let Some(predecessor) = predecessor {
            publications.push(predecessor);
        }
        self.state.record_publications(
            &self.config.network_id,
            &self.config.contract_address,
            &publications,
        )?;
        self.status.write().await.published =
            Some(identity(current_generation, &latest.state_digest));
        self.latest_publication = Some(latest.clone());
        self.publication_reconciled = true;
        Ok(Some(latest))
    }

    fn fail_if(&mut self, point: FailurePoint) -> Result<(), ServiceError> {
        if self.failure_point == Some(point) {
            self.failure_point = None;
            return Err(ServiceError::Injected(point));
        }
        Ok(())
    }
}

pub fn initial_status() -> LifeStatus {
    LifeStatus {
        schema_version: 1,
        state: IndexerState::Idle,
        observed: None,
        preparing: None,
        published: None,
        retry: None,
        error_code: None,
        heartbeat_at: now(),
    }
}
fn identity(generation: u64, digest: &str) -> PublishedIdentity {
    PublishedIdentity {
        generation: generation.to_string(),
        state_digest: digest.into(),
    }
}
fn hex32(value: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(value))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn timestamp_after(duration: Duration) -> String {
    (chrono::Utc::now() + chrono::Duration::from_std(duration).unwrap_or_default())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn error_code(error: &ServiceError) -> &'static str {
    match error {
        ServiceError::Source(_) => "SOURCE_ERROR",
        ServiceError::State(_) => "STATE_ERROR",
        ServiceError::Storage(_) => "PUBLICATION_ERROR",
        ServiceError::Snapshot(crate::Error::Digest { .. }) => "DIGEST_MISMATCH",
        ServiceError::Snapshot(_) => "SNAPSHOT_INVALID",
        ServiceError::EventRetentionGap { .. } => "EVENT_RETENTION_GAP",
        ServiceError::EventIndexBehind { .. } => "EVENT_INDEX_BEHIND",
        ServiceError::MissingLifecycleEvidence { .. } => "EVENT_EVIDENCE_MISSING",
        ServiceError::Injected(_) => "INJECTED_FAILURE",
    }
}

#[doc(hidden)]
pub fn retry_delay(attempt: u32, base: Duration, maximum: Duration) -> Duration {
    let exponent = attempt.saturating_sub(1).min(31);
    base.saturating_mul(1u32 << exponent).min(maximum)
}
