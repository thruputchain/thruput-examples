use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use fs2::FileExt;

use crate::{
    Artifact, CELL_TILE_BYTES, DENSITY_TILE_BYTES, LatestPointer, LifeManifest, LifeProvenance,
    MAX_ZOOM,
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(
        "artifact filesystem does not provide the required atomic rename and directory fsync semantics: {0}"
    )]
    Unsupported(String),
    #[error("invalid artifact path: {0}")]
    InvalidPath(String),
    #[error("immutable artifact collision at {0}")]
    Collision(String),
    #[error("stale generation {candidate}; latest is {latest}")]
    Stale { candidate: u64, latest: u64 },
    #[error("another writer already owns the artifact root")]
    WriterActive,
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid published schema: {0}")]
    Schema(#[from] crate::Error),
    #[error("JSON encoding failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub struct Publisher {
    root: PathBuf,
    _writer_lock: File,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeFailure {
    Rename,
    DirectorySync,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyIdentity {
    pub generation: u64,
    pub state_digest: String,
}

impl Publisher {
    pub fn open(root: PathBuf) -> Result<Self, StorageError> {
        Self::open_inner(root, None)
    }

    #[doc(hidden)]
    pub fn open_with_probe_failure(
        root: PathBuf,
        failure: ProbeFailure,
    ) -> Result<Self, StorageError> {
        Self::open_inner(root, Some(failure))
    }

    fn open_inner(root: PathBuf, failure: Option<ProbeFailure>) -> Result<Self, StorageError> {
        fs::create_dir_all(&root).map_err(|source| io(&root, source))?;
        let lock_path = root.join(".writer.lock");
        let writer_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|source| io(&lock_path, source))?;
        writer_lock
            .try_lock_exclusive()
            .map_err(|_| StorageError::WriterActive)?;
        let publisher = Self {
            root,
            _writer_lock: writer_lock,
        };
        publisher.probe(failure)?;
        Ok(publisher)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn latest(
        &self,
        network: &str,
        contract: &str,
    ) -> Result<Option<LatestPointer>, StorageError> {
        validate_identity(network, contract, &format!("0x{}", "0".repeat(64)))?;
        let path = self
            .root
            .join("v1/worlds")
            .join(network)
            .join(contract)
            .join("latest.json");
        match fs::read(&path) {
            Ok(bytes) => {
                let latest = LatestPointer::from_json_for(&bytes, network, contract)?;
                let candidate = path
                    .parent()
                    .ok_or_else(|| StorageError::InvalidPath(path.display().to_string()))?
                    .join(&latest.state_digest);
                self.verify_ready(network, contract, &candidate, &latest.state_digest)?;
                Ok(Some(latest))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(io(path, source)),
        }
    }

    fn probe(&self, failure: Option<ProbeFailure>) -> Result<(), StorageError> {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let stem = format!(
            ".durability-probe.{}.{}.{}",
            std::process::id(),
            timestamp,
            sequence
        );
        let from = self.root.join(format!("{stem}.tmp"));
        let to = self.root.join(format!("{stem}.renamed"));
        let result = (|| {
            self.write_synced(&from, b"probe")?;
            if failure == Some(ProbeFailure::Rename) {
                return Err(StorageError::Unsupported(
                    "injected startup probe rename failure".into(),
                ));
            }
            fs::rename(&from, &to)
                .map_err(|source| StorageError::Unsupported(source.to_string()))?;
            if failure == Some(ProbeFailure::DirectorySync) {
                return Err(StorageError::Unsupported(
                    "injected startup probe directory fsync failure".into(),
                ));
            }
            self.sync_dir(&self.root)
                .map_err(|error| StorageError::Unsupported(error.to_string()))?;
            fs::remove_file(&to).map_err(|source| io(&to, source))?;
            self.sync_dir(&self.root)
                .map_err(|error| StorageError::Unsupported(error.to_string()))
        })();
        let cleanup = self.cleanup_probe(&from, &to);
        match result {
            Ok(()) => cleanup,
            Err(error) => {
                cleanup?;
                Err(error)
            }
        }
    }

    fn cleanup_probe(&self, from: &Path, to: &Path) -> Result<(), StorageError> {
        for path in [from, to] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => return Err(io(path, source)),
            }
        }
        self.sync_dir(&self.root)
    }

    pub fn publish_snapshot(
        &self,
        network: &str,
        contract: &str,
        digest: &str,
        artifacts: &[Artifact],
    ) -> Result<(), StorageError> {
        validate_identity(network, contract, digest)?;
        validate_artifacts(network, contract, artifacts, digest)?;
        let base = self
            .root
            .join("v1/worlds")
            .join(network)
            .join(contract)
            .join(digest);
        self.ensure_dir(&base)?;
        let manifest_index = artifacts
            .iter()
            .position(|item| item.path.as_str() == "manifest.json")
            .ok_or_else(|| StorageError::InvalidPath("manifest.json is missing".into()))?;
        for (index, artifact) in artifacts.iter().enumerate() {
            if index != manifest_index {
                self.install_immutable(&base, artifact.path.as_str(), &artifact.bytes)?;
            }
        }
        self.install_immutable(&base, "manifest.json", &artifacts[manifest_index].bytes)?;
        self.verify_ready(network, contract, &base, digest)?;
        Ok(())
    }

    pub fn promote(
        &self,
        network: &str,
        contract: &str,
        pointer: &LatestPointer,
    ) -> Result<bool, StorageError> {
        pointer.validate_for(network, contract)?;
        let scope = self.root.join("v1/worlds").join(network).join(contract);
        let candidate = scope.join(&pointer.state_digest).join("manifest.json");
        self.verify_ready(
            network,
            contract,
            candidate
                .parent()
                .ok_or_else(|| StorageError::InvalidPath(candidate.display().to_string()))?,
            &pointer.state_digest,
        )?;
        let latest = scope.join("latest.json");
        if let Ok(bytes) = fs::read(&latest) {
            let current = LatestPointer::from_json_for(&bytes, network, contract)?;
            let current_generation: u64 =
                current
                    .generation
                    .parse()
                    .map_err(|_| crate::Error::Schema {
                        field: "generation",
                        reason: "invalid stored generation",
                    })?;
            let candidate_generation: u64 =
                pointer
                    .generation
                    .parse()
                    .map_err(|_| crate::Error::Schema {
                        field: "generation",
                        reason: "invalid candidate generation",
                    })?;
            if candidate_generation < current_generation {
                return Err(StorageError::Stale {
                    candidate: candidate_generation,
                    latest: current_generation,
                });
            }
            if candidate_generation == current_generation {
                if current.state_digest != pointer.state_digest {
                    return Err(StorageError::Collision(latest.display().to_string()));
                }
                return Ok(false);
            }
        }
        self.atomic_replace(&scope, "latest.json", &serde_json::to_vec(pointer)?)?;
        Ok(true)
    }

    pub fn ready_identities(
        &self,
        network: &str,
        contract: &str,
    ) -> Result<Vec<ReadyIdentity>, StorageError> {
        validate_identity(network, contract, &format!("0x{}", "0".repeat(64)))?;
        let scope = self.root.join("v1/worlds").join(network).join(contract);
        let entries = match fs::read_dir(&scope) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(io(&scope, source)),
        };
        let mut identities = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|source| io(&scope, source))?;
            let digest = entry.file_name().to_string_lossy().into_owned();
            if !entry
                .file_type()
                .map_err(|source| io(entry.path(), source))?
                .is_dir()
                || !canonical_hex(&digest)
                || !entry.path().join("manifest.json").exists()
            {
                continue;
            }
            let (manifest, _) = self.verify_ready(network, contract, &entry.path(), &digest)?;
            let generation = manifest
                .generation
                .parse()
                .map_err(|_| crate::Error::Schema {
                    field: "generation",
                    reason: "ready manifest generation is invalid",
                })?;
            identities.push(ReadyIdentity {
                generation,
                state_digest: digest,
            });
        }
        identities.sort_by_key(|identity| identity.generation);
        Ok(identities)
    }

    pub fn cleanup(
        &self,
        network: &str,
        contract: &str,
        retained: &[String],
    ) -> Result<Vec<String>, StorageError> {
        validate_identity(network, contract, &format!("0x{}", "0".repeat(64)))?;
        let scope = self.root.join("v1/worlds").join(network).join(contract);
        let mut removed = Vec::new();
        let entries = match fs::read_dir(&scope) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(removed),
            Err(source) => return Err(io(&scope, source)),
        };
        for entry in entries {
            let entry = entry.map_err(|source| io(&scope, source))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry
                .file_type()
                .map_err(|source| io(entry.path(), source))?
                .is_dir()
                && canonical_hex(&name)
                && !retained.contains(&name)
            {
                fs::remove_dir_all(entry.path()).map_err(|source| io(entry.path(), source))?;
                removed.push(name);
            }
        }
        self.sync_dir(&scope)?;
        Ok(removed)
    }

    fn install_immutable(
        &self,
        base: &Path,
        relative: &str,
        bytes: &[u8],
    ) -> Result<(), StorageError> {
        let relative = confined(relative)?;
        let destination = base.join(relative);
        if let Ok(existing) = fs::read(&destination) {
            return if existing == bytes {
                Ok(())
            } else {
                Err(StorageError::Collision(destination.display().to_string()))
            };
        }
        let parent = destination
            .parent()
            .ok_or_else(|| StorageError::InvalidPath(relative.display().to_string()))?;
        self.ensure_dir(parent)?;
        let name = destination
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| StorageError::InvalidPath(relative.display().to_string()))?;
        self.atomic_replace(parent, name, bytes)
    }

    fn verify_ready(
        &self,
        network: &str,
        contract: &str,
        base: &Path,
        digest: &str,
    ) -> Result<(LifeManifest, LifeProvenance), StorageError> {
        let manifest_path = base.join("manifest.json");
        let provenance_path = base.join("provenance.json");
        let manifest = LifeManifest::from_json(
            &fs::read(&manifest_path).map_err(|source| io(&manifest_path, source))?,
        )?;
        let provenance = LifeProvenance::from_json(
            &fs::read(&provenance_path).map_err(|source| io(&provenance_path, source))?,
        )?;
        if manifest.network_id != network
            || provenance.network_id != network
            || manifest.contract_address != contract
            || provenance.contract_address != contract
            || manifest.state_digest != digest
            || provenance.state_digest != digest
            || manifest.generation != provenance.generation
            || manifest.seed != provenance.seed
            || manifest.population != provenance.population
        {
            return Err(StorageError::Collision(base.display().to_string()));
        }
        for z in 0..=MAX_ZOOM {
            let count = 10_000u32.div_ceil(256 * (1u32 << (MAX_ZOOM - z)));
            let expected = if z == MAX_ZOOM {
                CELL_TILE_BYTES as u64
            } else {
                DENSITY_TILE_BYTES as u64
            };
            for x in 0..count {
                for y in 0..count {
                    let path = base.join(format!("tiles/{z}/{x}/{y}.bin"));
                    let actual = fs::metadata(&path)
                        .map_err(|source| io(&path, source))?
                        .len();
                    if actual != expected {
                        return Err(StorageError::Collision(path.display().to_string()));
                    }
                }
            }
        }
        Ok((manifest, provenance))
    }

    fn atomic_replace(&self, parent: &Path, name: &str, bytes: &[u8]) -> Result<(), StorageError> {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp = parent.join(format!(
            ".{name}.{}.{}.{}.tmp",
            std::process::id(),
            timestamp,
            sequence
        ));
        self.write_synced(&temp, bytes)?;
        fs::rename(&temp, parent.join(name)).map_err(|source| io(parent, source))?;
        self.sync_dir(parent)
    }

    fn write_synced(&self, path: &Path, bytes: &[u8]) -> Result<(), StorageError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|source| io(path, source))?;
        file.write_all(bytes).map_err(|source| io(path, source))?;
        file.sync_all().map_err(|source| io(path, source))
    }

    fn sync_dir(&self, path: &Path) -> Result<(), StorageError> {
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|source| io(path, source))
    }

    fn ensure_dir(&self, path: &Path) -> Result<(), StorageError> {
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| StorageError::InvalidPath(path.display().to_string()))?;
        let mut current = self.root.clone();
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err(StorageError::InvalidPath(path.display().to_string()));
            };
            let child = current.join(component);
            match fs::create_dir(&child) {
                Ok(()) => self.sync_dir(&current)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(source) => return Err(io(&child, source)),
            }
            current = child;
        }
        self.sync_dir(path)
    }
}

fn validate_artifacts(
    network: &str,
    contract: &str,
    artifacts: &[Artifact],
    digest: &str,
) -> Result<(), StorageError> {
    let mut paths = HashMap::with_capacity(artifacts.len());
    for artifact in artifacts {
        confined(artifact.path.as_str())?;
        if paths
            .insert(artifact.path.as_str(), artifact.bytes.as_slice())
            .is_some()
        {
            return Err(StorageError::InvalidPath(format!(
                "duplicate {}",
                artifact.path.as_str()
            )));
        }
    }
    let manifest = LifeManifest::from_json(
        paths
            .get("manifest.json")
            .ok_or_else(|| StorageError::InvalidPath("manifest.json is missing".into()))?,
    )?;
    let provenance = LifeProvenance::from_json(
        paths
            .get("provenance.json")
            .ok_or_else(|| StorageError::InvalidPath("provenance.json is missing".into()))?,
    )?;
    if manifest.network_id != network
        || provenance.network_id != network
        || manifest.contract_address != contract
        || provenance.contract_address != contract
        || manifest.state_digest != digest
        || provenance.state_digest != digest
        || manifest.generation != provenance.generation
        || manifest.seed != provenance.seed
        || manifest.population != provenance.population
    {
        return Err(StorageError::Collision(digest.into()));
    }
    let mut expected_count = 2usize;
    for z in 0..=MAX_ZOOM {
        let count = 10_000u32.div_ceil(256 * (1u32 << (MAX_ZOOM - z)));
        let expected_length = if z == MAX_ZOOM {
            CELL_TILE_BYTES
        } else {
            DENSITY_TILE_BYTES
        };
        for x in 0..count {
            for y in 0..count {
                expected_count += 1;
                let path = format!("tiles/{z}/{x}/{y}.bin");
                let actual = paths.get(path.as_str()).map_or(0, |bytes| bytes.len());
                if actual != expected_length {
                    return Err(StorageError::Collision(path));
                }
            }
        }
    }
    if paths.len() != expected_count {
        return Err(StorageError::InvalidPath(
            "artifact inventory contains unknown paths".into(),
        ));
    }
    Ok(())
}

pub fn resolve_request(root: &Path, request_path: &str) -> Result<PathBuf, StorageError> {
    if request_path.contains('%') || request_path.contains('\\') {
        return Err(StorageError::InvalidPath(request_path.into()));
    }
    let relative = request_path
        .strip_prefix('/')
        .ok_or_else(|| StorageError::InvalidPath(request_path.into()))?;
    Ok(root.join(confined(relative)?))
}

fn confined(value: &str) -> Result<&Path, StorageError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(StorageError::InvalidPath(value.into()));
    }
    Ok(path)
}

fn validate_identity(network: &str, contract: &str, digest: &str) -> Result<(), StorageError> {
    if network.len() != 64
        || !network.bytes().all(lower_hex)
        || !canonical_hex(contract)
        || !canonical_hex(digest)
    {
        return Err(StorageError::InvalidPath(format!(
            "{network}/{contract}/{digest}"
        )));
    }
    Ok(())
}

fn canonical_hex(value: &str) -> bool {
    value.len() == 66 && value.starts_with("0x") && value[2..].bytes().all(lower_hex)
}
fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}
fn io(path: impl Into<PathBuf>, source: std::io::Error) -> StorageError {
    StorageError::Io {
        path: path.into(),
        source,
    }
}
