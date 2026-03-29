use events::*;
use sdk::*;

static EVENTS_NONCE: SHA256Hash = sdk::sha256_static!("EVENTS_TEST_NONCE");

fn setup() -> (TestEnvironmentHandle, SHA256Hash) {
    let env = TestEnvironment::no_cost();
    let contract = env.register_mock(Events::__mock);
    let contract_hash = env.setup_create_contract(&contract);
    (env, contract_hash)
}

// ── Payload-only event (no user topics) ──────────────────────────────────

#[test]
fn test_value_stored_event() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&EVENTS_NONCE, &contract_hash);
            let client = EventsClient::new(&addr);
            client.store_value(42, 100);
        })
    });
    result.assert_success();
    result.assert_event_count(1);

    // ValueStored has 1 topic (auto-generated SIGNATURE) and 2 payload fields
    result.assert_event::<ValueStored>(0, |e| {
        assert_eq!(e.num_topics(), 1);
        assert_eq!(e.topic(0).unwrap(), ValueStored::SIGNATURE);
        assert_eq!(e.payload().key, 42);
        assert_eq!(e.payload().value, 100);
    });
}

// ── Address topics (zero-copy, 32-byte pass-through) ─────────────────────

#[test]
fn test_transfer_event_with_address_topics() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&EVENTS_NONCE, &contract_hash);
            let client = EventsClient::new(&addr);

            let from: ContractAddress = [0xAAu8; 32].into();
            let to: ContractAddress = [0xBBu8; 32].into();
            client.transfer(&from, &to, 1000);
        })
    });
    result.assert_success();
    result.assert_event_count(1);

    // Transfer has 3 topics: SIGNATURE + from + to
    result.assert_event::<Transfer>(0, |e| {
        assert_eq!(e.num_topics(), 3);
        assert_eq!(e.topic(0).unwrap(), Transfer::SIGNATURE);
        assert_eq!(e.topic(1).unwrap(), &[0xAAu8; 32]);
        assert_eq!(e.topic(2).unwrap(), &[0xBBu8; 32]);
        assert_eq!(e.payload().amount, 1000);
    });
}

// ── Hashed topics (non-32-byte types, XDR-encoded + SHA-256) ─────────────

#[test]
fn test_tagged_action_with_hashed_topics() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&EVENTS_NONCE, &contract_hash);
            let client = EventsClient::new(&addr);
            client.tag_action(b"audit", 7, b"details here");
        })
    });
    result.assert_success();
    result.assert_event_count(1);

    // TaggedAction has 3 topics: SIGNATURE + hashed category + hashed code.
    // Non-32-byte topic values are XDR-encoded then SHA-256 hashed.
    use sha2::{Digest, Sha256};
    let expected_category: [u8; 32] = {
        let encoded = encode_xdr(&"audit").unwrap();
        Sha256::digest(encoded.as_ref()).into()
    };
    let expected_code: [u8; 32] = {
        let encoded = encode_xdr(&7u32).unwrap();
        Sha256::digest(encoded.as_ref()).into()
    };

    result.assert_event::<TaggedAction>(0, |e| {
        assert_eq!(e.num_topics(), 3);
        assert_eq!(e.topic(0).unwrap(), TaggedAction::SIGNATURE);
        assert_eq!(e.topic(1).unwrap(), &expected_category);
        assert_eq!(e.topic(2).unwrap(), &expected_code);
        assert_eq!(e.payload().detail, b"details here");
    });
}

// ── Topics-only event (no payload fields) ────────────────────────────────

#[test]
fn test_checkpoint_topics_only() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&EVENTS_NONCE, &contract_hash);
            let client = EventsClient::new(&addr);

            let origin: ContractAddress = [0xCCu8; 32].into();
            client.checkpoint(&origin);
        })
    });
    result.assert_success();
    result.assert_event_count(1);

    // Checkpoint has 2 topics: SIGNATURE + origin. No payload.
    result.assert_event::<Checkpoint>(0, |e| {
        assert_eq!(e.num_topics(), 2);
        assert_eq!(e.topic(0).unwrap(), Checkpoint::SIGNATURE);
        assert_eq!(e.topic(1).unwrap(), &[0xCCu8; 32]);
    });
}

// ── Multiple events in one call ──────────────────────────────────────────

#[test]
fn test_multi_emit() {
    let (env, contract_hash) = setup();

    let result = env.transact(|tx| {
        tx.call(&[1u8; 32].into()).run(|| {
            let addr = deploy_contract(&EVENTS_NONCE, &contract_hash);
            let client = EventsClient::new(&addr);

            let test_addr: ContractAddress = [0xDDu8; 32].into();
            client.multi_emit(&test_addr);
        })
    });
    result.assert_success();
    result.assert_event_count(3);

    // Event 0: ValueStored
    result.assert_event::<ValueStored>(0, |e| {
        assert_eq!(e.topic(0).unwrap(), ValueStored::SIGNATURE);
        assert_eq!(e.payload().key, 1);
        assert_eq!(e.payload().value, 100);
    });

    // Event 1: Transfer
    result.assert_event::<Transfer>(1, |e| {
        assert_eq!(e.topic(0).unwrap(), Transfer::SIGNATURE);
        assert_eq!(e.topic(1).unwrap(), &[0xDDu8; 32]);
        assert_eq!(e.topic(2).unwrap(), &[0xDDu8; 32]);
        assert_eq!(e.payload().amount, 50);
        assert_eq!(e.payload().memo, b"batch");
    });

    // Event 2: Checkpoint
    result.assert_event::<Checkpoint>(2, |e| {
        assert_eq!(e.topic(0).unwrap(), Checkpoint::SIGNATURE);
        assert_eq!(e.topic(1).unwrap(), &[0xDDu8; 32]);
    });
}

// ── Signature uniqueness ─────────────────────────────────────────────────

#[test]
fn test_event_signatures_are_unique() {
    // Each event type gets a unique SIGNATURE derived from its name
    assert_ne!(ValueStored::SIGNATURE, Transfer::SIGNATURE);
    assert_ne!(Transfer::SIGNATURE, TaggedAction::SIGNATURE);
    assert_ne!(TaggedAction::SIGNATURE, Checkpoint::SIGNATURE);
}
