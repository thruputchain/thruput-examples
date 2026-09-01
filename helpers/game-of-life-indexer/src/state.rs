use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::schema::LifeProvenance;

#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("SQLite state error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("stored provenance is invalid: {0}")]
    Provenance(#[from] crate::Error),
    #[error("conflicting immutable evidence already exists for {digest}")]
    EvidenceConflict { digest: String },
}

pub struct StateStore {
    connection: Connection,
}

impl StateStore {
    pub fn open(path: &Path) -> Result<Self, StateError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS service_state (
                key TEXT PRIMARY KEY, value BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS evidence (
                network TEXT NOT NULL, contract TEXT NOT NULL, generation TEXT NOT NULL,
                digest TEXT NOT NULL, provenance BLOB NOT NULL,
                PRIMARY KEY (network, contract, digest)
             );
             CREATE TABLE IF NOT EXISTS publications (
                network TEXT NOT NULL, contract TEXT NOT NULL, generation TEXT NOT NULL,
                digest TEXT NOT NULL, promoted_at INTEGER NOT NULL,
                PRIMARY KEY (network, contract, digest)
             );
             CREATE TABLE IF NOT EXISTS chain_events (
                scope TEXT NOT NULL, transaction_hash TEXT NOT NULL, event_index INTEGER NOT NULL,
                event BLOB NOT NULL, PRIMARY KEY(scope, transaction_hash, event_index)
             );",
        )?;
        Ok(Self { connection })
    }

    pub fn cursor(&self, scope: &str) -> Result<Option<Vec<u8>>, StateError> {
        Ok(self
            .connection
            .query_row(
                "SELECT value FROM service_state WHERE key = ?1",
                [format!("cursor:{scope}")],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn set_cursor(&self, scope: &str, cursor: &[u8]) -> Result<(), StateError> {
        self.connection.execute(
            "INSERT INTO service_state(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![format!("cursor:{scope}"), cursor],
        )?;
        Ok(())
    }

    pub fn save_chain_events(
        &self,
        scope: &str,
        events: &[crate::source::ChainEvent],
    ) -> Result<(), StateError> {
        let mut statement = self.connection.prepare(
            "INSERT INTO chain_events(scope,transaction_hash,event_index,event)
             VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",
        )?;
        for event in events {
            statement.execute(params![
                scope,
                event.transaction_hash,
                event.event_index,
                serde_json::to_vec(event).map_err(|error| crate::Error::Json(error.to_string()))?
            ])?;
        }
        Ok(())
    }

    pub fn save_event_batch(
        &self,
        scope: &str,
        events: &[crate::source::ChainEvent],
        cursor: &[u8],
    ) -> Result<(), StateError> {
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO chain_events(scope,transaction_hash,event_index,event)
                 VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",
            )?;
            for event in events {
                statement.execute(params![
                    scope,
                    event.transaction_hash,
                    event.event_index,
                    serde_json::to_vec(event)
                        .map_err(|error| crate::Error::Json(error.to_string()))?
                ])?;
            }
        }
        transaction.execute(
            "INSERT INTO service_state(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![format!("cursor:{scope}"), cursor],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn chain_events(&self, scope: &str) -> Result<Vec<crate::source::ChainEvent>, StateError> {
        let mut statement = self
            .connection
            .prepare("SELECT event FROM chain_events WHERE scope=?1 ORDER BY rowid")?;
        let rows = statement.query_map([scope], |row| row.get::<_, Vec<u8>>(0))?;
        rows.map(|row| {
            serde_json::from_slice(&row?)
                .map_err(|error| StateError::Provenance(crate::Error::Json(error.to_string())))
        })
        .collect()
    }

    pub fn save_evidence(&self, provenance: &LifeProvenance) -> Result<(), StateError> {
        self.persist_evidence(provenance)?;
        Ok(())
    }

    pub fn resolve_evidence(
        &self,
        provenance: &LifeProvenance,
    ) -> Result<Option<LifeProvenance>, StateError> {
        provenance.validate()?;
        if let Some(stored) = self.evidence(
            &provenance.network_id,
            &provenance.contract_address,
            &provenance.state_digest,
        )? {
            let mut candidate = provenance.clone();
            candidate
                .source_block_height
                .clone_from(&stored.source_block_height);
            candidate
                .source_block_hash
                .clone_from(&stored.source_block_hash);
            candidate.verified_at.clone_from(&stored.verified_at);
            if candidate != stored {
                return Err(StateError::EvidenceConflict {
                    digest: provenance.state_digest.clone(),
                });
            }
            return Ok(Some(stored));
        }
        Ok(None)
    }

    pub fn persist_evidence(
        &self,
        provenance: &LifeProvenance,
    ) -> Result<LifeProvenance, StateError> {
        if let Some(stored) = self.resolve_evidence(provenance)? {
            return Ok(stored);
        }
        let bytes = serde_json::to_vec(provenance)
            .map_err(|error| crate::Error::Json(error.to_string()))?;
        self.connection.execute(
            "INSERT INTO evidence(network,contract,generation,digest,provenance)
             VALUES(?1,?2,?3,?4,?5)",
            params![
                provenance.network_id,
                provenance.contract_address,
                provenance.generation,
                provenance.state_digest,
                bytes
            ],
        )?;
        Ok(provenance.clone())
    }

    pub fn evidence(
        &self,
        network: &str,
        contract: &str,
        digest: &str,
    ) -> Result<Option<LifeProvenance>, StateError> {
        let bytes: Option<Vec<u8>> = self
            .connection
            .query_row(
                "SELECT provenance FROM evidence WHERE network=?1 AND contract=?2 AND digest=?3",
                params![network, contract, digest],
                |row| row.get(0),
            )
            .optional()?;
        bytes
            .map(|bytes| LifeProvenance::from_json(&bytes).map_err(StateError::from))
            .transpose()
    }

    pub fn record_publication(
        &self,
        network: &str,
        contract: &str,
        generation: u64,
        digest: &str,
        promoted_at: i64,
    ) -> Result<(), StateError> {
        self.connection.execute(
            "INSERT INTO publications(network,contract,generation,digest,promoted_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT DO UPDATE SET promoted_at=MAX(promoted_at,excluded.promoted_at)",
            params![network, contract, generation.to_string(), digest, promoted_at],
        )?;
        Ok(())
    }

    pub fn record_publications(
        &self,
        network: &str,
        contract: &str,
        publications: &[(u64, String, i64)],
    ) -> Result<(), StateError> {
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO publications(network,contract,generation,digest,promoted_at)
                 VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT DO UPDATE SET promoted_at=MAX(promoted_at,excluded.promoted_at)",
            )?;
            for (generation, digest, promoted_at) in publications {
                statement.execute(params![
                    network,
                    contract,
                    generation.to_string(),
                    digest,
                    promoted_at
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn publication(
        &self,
        network: &str,
        contract: &str,
        digest: &str,
    ) -> Result<Option<(u64, i64)>, StateError> {
        let row: Option<(String, i64)> = self
            .connection
            .query_row(
                "SELECT generation,promoted_at FROM publications
                 WHERE network=?1 AND contract=?2 AND digest=?3",
                params![network, contract, digest],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(generation, promoted_at)| {
            generation
                .parse()
                .map(|generation| (generation, promoted_at))
                .map_err(|_| {
                    StateError::Provenance(crate::Error::Schema {
                        field: "generation",
                        reason: "stored publication generation is invalid",
                    })
                })
        })
        .transpose()
    }

    pub fn predecessor_publication(
        &self,
        network: &str,
        contract: &str,
        generation: u64,
    ) -> Result<Option<(u64, String, i64)>, StateError> {
        let generation = generation.to_string();
        let row: Option<(String, String, i64)> = self
            .connection
            .query_row(
                "SELECT generation,digest,promoted_at FROM publications
                 WHERE network=?1 AND contract=?2 AND
                   (length(generation)<length(?3) OR
                    (length(generation)=length(?3) AND generation<?3))
                 ORDER BY length(generation) DESC,generation DESC LIMIT 1",
                params![network, contract, generation],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        row.map(|(generation, digest, promoted_at)| {
            generation
                .parse()
                .map(|generation| (generation, digest, promoted_at))
                .map_err(|_| {
                    StateError::Provenance(crate::Error::Schema {
                        field: "generation",
                        reason: "stored publication generation is invalid",
                    })
                })
        })
        .transpose()
    }

    pub fn retained_digests(
        &self,
        network: &str,
        contract: &str,
        grace_after: i64,
    ) -> Result<Vec<String>, StateError> {
        let mut statement = self.connection.prepare(
            "SELECT digest FROM publications WHERE network=?1 AND contract=?2
             AND (promoted_at>=?3 OR generation IN (
                SELECT generation FROM publications WHERE network=?1 AND contract=?2
                ORDER BY length(generation) DESC, generation DESC LIMIT 2
             ))",
        )?;
        let rows =
            statement.query_map(params![network, contract, grace_after], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
