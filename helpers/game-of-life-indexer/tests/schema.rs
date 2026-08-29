use game_of_life_indexer::{
    EventKind, EvidenceKind, IndexerState, LatestPointer, LifeManifest, LifeProvenance, LifeStatus,
    Progress, ProgressUnit, PublishedIdentity, Retry, SnapshotIdentity,
};

const NETWORK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const CONTRACT: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const DIGEST: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOCK: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSACTION: &str = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REQUEST: &str = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const REQUESTER: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

#[test]
fn latest_pointer_context_free_validation_accepts_only_digest_relative_path() {
    let valid = latest(format!("{DIGEST}/manifest.json"));
    assert!(valid.validate().is_ok());

    for path in [
        format!("/{DIGEST}/manifest.json"),
        format!("{DIGEST}//manifest.json"),
        format!("{DIGEST}/../manifest.json"),
        format!("{DIGEST}%2fmanifest.json"),
        format!("{DIGEST}\\manifest.json"),
        format!("https://example.test/{DIGEST}/manifest.json"),
        format!("//example.test/{DIGEST}/manifest.json"),
        format!("{DIGEST}/manifest.json?x=1"),
        format!("{DIGEST}/manifest.json#x"),
    ] {
        let invalid = latest(path.clone());
        assert!(invalid.validate().is_err(), "accepted {path}");
    }
}

#[test]
fn latest_pointer_context_validation_requires_exact_canonical_scope() {
    let canonical = format!("/v1/worlds/{NETWORK}/{CONTRACT}/{DIGEST}/manifest.json");
    let valid = latest(canonical.clone());
    assert!(valid.validate_for(NETWORK, CONTRACT).is_ok());
    let bytes = serde_json::to_vec(&valid).unwrap();
    assert_eq!(
        LatestPointer::from_json_for(&bytes, NETWORK, CONTRACT).unwrap(),
        valid
    );
    assert!(LatestPointer::from_json(&bytes).is_err());

    let other_network = "9999999999999999999999999999999999999999999999999999999999999999";
    let other_contract = "0x9999999999999999999999999999999999999999999999999999999999999999";
    assert!(valid.validate_for(other_network, CONTRACT).is_err());
    assert!(valid.validate_for(NETWORK, other_contract).is_err());

    for path in [
        canonical.replace("/v1/", "/v2/"),
        canonical.replace(NETWORK, &format!("{NETWORK}%2f..")),
        canonical.replace(CONTRACT, &format!("{CONTRACT}\\..")),
        canonical.replace("/worlds/", "//worlds/"),
        format!("https://host{canonical}"),
        format!("//host{canonical}"),
        format!("{canonical}?x=1"),
        format!("{canonical}#x"),
        format!("{canonical}/.."),
    ] {
        let invalid = latest(path.clone());
        assert!(
            invalid.validate_for(NETWORK, CONTRACT).is_err(),
            "accepted {path}"
        );
    }
}

#[test]
fn provenance_parser_enforces_event_generation_and_cross_fields() {
    let initialized = initialized_provenance();
    let bytes = serde_json::to_vec(&initialized).unwrap();
    assert_eq!(LifeProvenance::from_json(&bytes).unwrap(), initialized);

    let mut invalid = initialized.clone();
    invalid.generation = "1".into();
    assert!(invalid.validate().is_err());
    invalid = initialized.clone();
    invalid.event_kind = Some(EventKind::GenerationAdvanced);
    assert!(invalid.validate().is_err());
    invalid = initialized.clone();
    invalid.request_id = Some(REQUEST.into());
    assert!(invalid.validate().is_err());

    let advanced = advanced_provenance();
    let bytes = serde_json::to_vec(&advanced).unwrap();
    assert_eq!(LifeProvenance::from_json(&bytes).unwrap(), advanced);
    let mut invalid = advanced.clone();
    invalid.generation = "0".into();
    assert!(invalid.validate().is_err());
    invalid = advanced.clone();
    invalid.requester = None;
    assert!(invalid.validate().is_err());

    let mut observation = initialized;
    observation.evidence_kind = EvidenceKind::MetadataObservation;
    assert!(observation.validate().is_err());

    let mut value = serde_json::to_value(advanced).unwrap();
    value["unknown"] = true.into();
    assert!(LifeProvenance::from_json(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn manifest_and_provenance_reject_population_above_world_capacity() {
    let manifest = LifeManifest::new(&SnapshotIdentity {
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        generation: 0,
        seed: 0,
        population: 100_000_001,
        state_digest: [0xaa; 32],
    });
    assert!(manifest.validate().is_err());

    let mut provenance = initialized_provenance();
    provenance.population = "100000001".into();
    assert!(provenance.validate().is_err());
}

#[test]
fn status_enforces_state_specific_fields_progress_and_identifiers() {
    let identity = PublishedIdentity {
        generation: "7".into(),
        state_digest: DIGEST.into(),
    };
    let valid = LifeStatus {
        schema_version: 1,
        state: IndexerState::Preparing,
        observed: Some(identity.clone()),
        preparing: Some(Progress {
            generation: "7".into(),
            state_digest: DIGEST.into(),
            completed_units: 20,
            total_units: 100,
            unit: ProgressUnit::Chunks,
        }),
        published: Some(identity),
        retry: Some(Retry {
            attempt: 2,
            next_at: "2026-08-28T01:02:03Z".into(),
        }),
        error_code: None,
        heartbeat_at: "2026-08-28T01:02:03Z".into(),
    };
    assert!(valid.validate().is_ok());

    let mut invalid = valid.clone();
    invalid.state = IndexerState::Idle;
    assert!(invalid.validate().is_err());
    invalid = valid.clone();
    invalid.preparing.as_mut().unwrap().completed_units = 101;
    assert!(invalid.validate().is_err());
    invalid = valid;
    invalid.error_code = Some("bad-code".into());
    assert!(invalid.validate().is_err());
}

#[test]
fn schemas_reject_noncanonical_decimal_unknown_fields_and_invalid_dates() {
    let bytes = format!(
        r#"{{"schemaVersion":1,"generation":"01","stateDigest":"{DIGEST}","manifestUrl":"{DIGEST}/manifest.json","sourceBlockHeight":"9","sourceBlockHash":"{BLOCK}","publishedAt":"2026-08-28T01:02:03Z"}}"#
    );
    assert!(LatestPointer::from_json(bytes.as_bytes()).is_err());

    let bytes = format!(
        r#"{{"schemaVersion":1,"generation":"1","stateDigest":"{DIGEST}","manifestUrl":"{DIGEST}/manifest.json","sourceBlockHeight":"9","sourceBlockHash":"{BLOCK}","publishedAt":"2026-08-28T01:02:03Z","extra":true}}"#
    );
    assert!(LatestPointer::from_json(bytes.as_bytes()).is_err());

    let bytes = format!(
        r#"{{"schemaVersion":1,"generation":"1","stateDigest":"{DIGEST}","manifestUrl":"{DIGEST}/manifest.json","sourceBlockHeight":"9","sourceBlockHash":"{BLOCK}","publishedAt":"2026-02-30T01:02:03Z"}}"#
    );
    assert!(LatestPointer::from_json(bytes.as_bytes()).is_err());
}

fn latest(manifest_url: String) -> LatestPointer {
    LatestPointer {
        schema_version: 1,
        generation: "7".into(),
        state_digest: DIGEST.into(),
        manifest_url,
        source_block_height: "9".into(),
        source_block_hash: BLOCK.into(),
        published_at: "2026-08-28T01:02:03.456Z".into(),
    }
}

fn initialized_provenance() -> LifeProvenance {
    LifeProvenance {
        schema_version: 1,
        network_id: NETWORK.into(),
        contract_address: CONTRACT.into(),
        generation: "0".into(),
        seed: "0".into(),
        population: "1".into(),
        state_digest: DIGEST.into(),
        source_block_height: "9".into(),
        source_block_hash: BLOCK.into(),
        evidence_kind: EvidenceKind::WorldInitializedEvent,
        transaction_hash: Some(TRANSACTION.into()),
        event_index: Some(0),
        event_kind: Some(EventKind::WorldInitialized),
        request_id: None,
        requester: None,
        verified_at: "2026-08-28T01:02:03Z".into(),
    }
}

fn advanced_provenance() -> LifeProvenance {
    LifeProvenance {
        generation: "1".into(),
        evidence_kind: EvidenceKind::GenerationAdvancedEvent,
        event_kind: Some(EventKind::GenerationAdvanced),
        request_id: Some(REQUEST.into()),
        requester: Some(REQUESTER.into()),
        ..initialized_provenance()
    }
}
