use groundhog_xdr::types::{ContractAddress, SHA256Hash};
use integration_test::{
    Harness, InvocationOptions, SubmissionOutcome, TransactionExpiry, decode_return, encode,
};
use std::time::Duration;

const INTERFACE: &str = "GameOfLife";
const VERSION: &str = "0.1.0";

#[derive(Debug, xdrs::ReadXDR)]
#[xdrs(crate = "::xdrs")]
struct WorldMetadata {
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

#[derive(Debug, xdrs::ReadXDR)]
#[xdrs(crate = "::xdrs")]
struct TickResult {
    request_id: SHA256Hash,
    requested_by: ContractAddress,
    metadata: WorldMetadata,
}

#[tokio::test]
#[ignore = "requires an initialized contract with at least two free queue slots"]
async fn concurrent_requests_commit_with_distinct_ids() {
    let harness = Harness::from_env(INTERFACE, VERSION);
    let options = InvocationOptions::default();
    let (one, two) = tokio::join!(
        harness.submit("request_tick", encode(&()), options),
        harness.submit("request_tick", encode(&()), options),
    );
    let receipt = |outcome: Result<SubmissionOutcome, _>| match outcome.expect("submit request") {
        SubmissionOutcome::Committed(receipt) => receipt,
        other => panic!("request did not commit: {other:?}"),
    };
    let one = receipt(one);
    let two = receipt(two);
    assert_eq!(one.height, two.height);
    let one_id: SHA256Hash = decode_return(&one);
    let two_id: SHA256Hash = decode_return(&two);
    assert_ne!(one_id, two_id);
    assert_eq!(one.events[0].topics[1].0, *one_id.as_ref());
    assert_eq!(two.events[0].topics[1].0, *two_id.as_ref());
}

#[tokio::test]
#[ignore = "requires an initialized contract"]
async fn rejects_reinitialization_and_out_of_bounds_reads() {
    let harness = Harness::from_env(INTERFACE, VERSION);
    for (method, calldata) in [
        ("initialize", encode(&(0u64, 64u32))),
        ("get_chunk", encode(&(10_000u32, 0u32))),
        ("get_cell", encode(&(10_000u32, 0u32))),
    ] {
        let outcome = harness
            .submit(method, calldata, InvocationOptions::default())
            .await
            .unwrap_or_else(|error| panic!("submit {method}: {error}"));
        assert!(
            matches!(outcome, SubmissionOutcome::Failed(_)),
            "{method} unexpectedly succeeded: {outcome:?}"
        );
    }
}

#[tokio::test]
#[ignore = "requires an initialized contract with an empty queue"]
async fn failed_crank_preserves_request_and_world() {
    let harness = Harness::from_env(INTERFACE, VERSION);
    let before: WorldMetadata = decode_return(&harness.invoke("get_metadata", encode(&())).await);
    let request = harness.invoke("request_tick", encode(&())).await;
    let request_id: SHA256Hash = decode_return(&request);

    let insufficient = InvocationOptions {
        outer_transaction_gas_limit: 7_510_000_000,
        target_call_gas_limit: 7_500_000_000,
        expiry: TransactionExpiry::Offset(1_000),
        receipt_timeout: Duration::from_secs(120),
        receipt_poll_interval: Duration::from_secs(1),
    };
    let failed = harness
        .submit("process_next_tick", encode(&()), insufficient)
        .await
        .expect("submit intentionally underfunded crank");
    assert!(matches!(failed, SubmissionOutcome::Failed(_)));

    let unchanged: WorldMetadata =
        decode_return(&harness.invoke("get_metadata", encode(&())).await);
    assert_eq!(unchanged.generation, before.generation);
    assert_eq!(unchanged.population, before.population);
    assert_eq!(unchanged.state_digest, before.state_digest);

    let sufficient = InvocationOptions {
        outer_transaction_gas_limit: 10_010_000_000,
        target_call_gas_limit: 10_000_000_000,
        ..insufficient
    };
    let retry = harness
        .submit("process_next_tick", encode(&()), sufficient)
        .await
        .expect("retry preserved request with sufficient gas");
    let retry = match retry {
        SubmissionOutcome::Committed(receipt) => receipt,
        other => panic!("retry did not commit: {other:?}"),
    };
    assert_eq!(retry.events[0].topics[1].0, *request_id.as_ref());
    let result: Option<TickResult> = decode_return(&retry);
    assert_eq!(
        result
            .expect("retry must consume the preserved request")
            .request_id,
        request_id
    );
}

#[tokio::test]
#[ignore = "requires the seed-zero contract immediately after its first crank"]
async fn generation_one_matches_reference() {
    let harness = Harness::from_env(INTERFACE, VERSION);
    let metadata: WorldMetadata = decode_return(&harness.invoke("get_metadata", encode(&())).await);
    assert_eq!(metadata.generation, 1);
    assert_eq!(metadata.population, 27_336_807);
    assert_eq!(
        metadata.state_digest,
        SHA256Hash::new([
            0x51, 0xae, 0xd4, 0x70, 0xa5, 0xda, 0xb0, 0x91, 0x13, 0x14, 0x71, 0x8a, 0xb3, 0xa6,
            0x41, 0xc0, 0x14, 0xe0, 0x68, 0x41, 0x95, 0x16, 0x48, 0xf0, 0xf0, 0x64, 0x66, 0x31,
            0x9f, 0x46, 0x5c, 0xe8,
        ])
    );
}

#[tokio::test]
#[ignore = "requires a funded storage fixture and live Groundhog node"]
async fn admits_production_read_write_shape() {
    let harness = Harness::from_env("LifeStorageAdmission", VERSION);
    let options = InvocationOptions {
        outer_transaction_gas_limit: 5_000_000_000,
        target_call_gas_limit: 4_900_000_000,
        expiry: TransactionExpiry::Offset(1_000),
        receipt_timeout: Duration::from_secs(120),
        receipt_poll_interval: Duration::from_secs(1),
    };

    assert!(matches!(
        harness
            .submit("write_chunks", encode(&(20_000u32,)), options)
            .await
            .expect("populate fixture source bank"),
        SubmissionOutcome::Committed(_)
    ));

    let started = std::time::Instant::now();
    let copy = harness
        .submit("copy_world", encode(&()), options)
        .await
        .expect("submit production-shaped storage transaction");
    match copy {
        SubmissionOutcome::Committed(receipt) => println!(
            "read 20,004 and wrote 20,000 chunks at height {} in {:?}; tx={:?}",
            *receipt.height,
            started.elapsed(),
            receipt.tx_hash
        ),
        other => panic!("production-shaped storage transaction failed: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires an initialized, funded contract and live Groundhog node"]
async fn advances_complete_world_once() {
    let harness = Harness::from_env(INTERFACE, VERSION);
    let before: WorldMetadata = decode_return(&harness.invoke("get_metadata", encode(&())).await);
    assert_eq!((before.width, before.height), (10_000, 10_000));

    let first_chunk: [u8; 1_000] =
        decode_return(&harness.invoke("get_chunk", encode(&(0u32, 0u32))).await);
    let tail_chunk: [u8; 1_000] =
        decode_return(&harness.invoke("get_chunk", encode(&(9_999u32, 1u32))).await);
    assert!(tail_chunk[250..].iter().all(|byte| *byte == 0));
    let first_cell: bool = decode_return(&harness.invoke("get_cell", encode(&(0u32, 0u32))).await);
    assert_eq!(first_cell, first_chunk[0] & 1 != 0);

    let request = harness.invoke("request_tick", encode(&())).await;
    assert_eq!(request.events.len(), 1);
    let request_id: SHA256Hash = decode_return(&request);
    assert_eq!(request.events[0].topics[1].0, *request_id.as_ref());

    let target_gas = env_u64("GAME_OF_LIFE_TARGET_GAS", 500_000_000_000);
    let process_options = InvocationOptions {
        outer_transaction_gas_limit: env_u64("GAME_OF_LIFE_OUTER_GAS", target_gas + 10_000_000),
        target_call_gas_limit: target_gas,
        expiry: TransactionExpiry::Offset(1_000),
        receipt_timeout: Duration::from_secs(env_u64("GAME_OF_LIFE_TIMEOUT_SECONDS", 600)),
        receipt_poll_interval: Duration::from_secs(1),
    };
    let started = std::time::Instant::now();
    let process = harness
        .submit("process_next_tick", encode(&()), process_options)
        .await
        .expect("submit full-world crank");
    let process = match process {
        SubmissionOutcome::Committed(receipt) => receipt,
        other => panic!("full-world crank did not commit: {other:?}"),
    };
    println!(
        "advanced complete world in {:?}; tx={:?}",
        started.elapsed(),
        process.tx_hash
    );
    assert_eq!(process.events.len(), 1);
    assert_eq!(process.events[0].topics[1].0, *request_id.as_ref());
    let result: Option<TickResult> = decode_return(&process);
    let result = result.expect("non-empty crank must return a result");
    assert_eq!(result.request_id, request_id);
    assert_eq!(result.requested_by, harness.wallet());
    assert_eq!(result.metadata.generation, before.generation + 1);

    let after: WorldMetadata = decode_return(&harness.invoke("get_metadata", encode(&())).await);
    assert_eq!(after.generation, before.generation + 1);
    assert_eq!(after.seed, before.seed);
    assert_ne!(after.state_digest, before.state_digest);
    assert!(after.population <= 100_000_000);
    if before.generation == 0 && before.seed == 0 {
        assert_eq!(after.population, 27_336_807);
        assert_eq!(
            after.state_digest,
            SHA256Hash::new([
                0x51, 0xae, 0xd4, 0x70, 0xa5, 0xda, 0xb0, 0x91, 0x13, 0x14, 0x71, 0x8a, 0xb3, 0xa6,
                0x41, 0xc0, 0x14, 0xe0, 0x68, 0x41, 0x95, 0x16, 0x48, 0xf0, 0xf0, 0x64, 0x66, 0x31,
                0x9f, 0x46, 0x5c, 0xe8,
            ])
        );
    }
    assert_eq!(after.chunk_bytes, 1_000);
    assert_eq!(after.chunks_per_row, 2);
    assert_eq!(after.max_queue_len, 64);

    let empty = harness.invoke("process_next_tick", encode(&())).await;
    assert!(empty.events.is_empty());
}

#[tokio::test]
#[ignore = "requires a funded storage fixture and live Groundhog node"]
async fn admits_generation_sized_storage_delta() {
    let harness = Harness::from_env("LifeStorageAdmission", VERSION);
    let chunk_count = env_u64("GAME_OF_LIFE_FIXTURE_CHUNKS", 20_000) as u32;
    let options = InvocationOptions {
        outer_transaction_gas_limit: env_u64("GAME_OF_LIFE_OUTER_GAS", 5_000_000_000),
        target_call_gas_limit: env_u64("GAME_OF_LIFE_TARGET_GAS", 4_900_000_000),
        expiry: TransactionExpiry::Offset(1_000),
        receipt_timeout: Duration::from_secs(120),
        receipt_poll_interval: Duration::from_secs(1),
    };

    let started = std::time::Instant::now();
    let outcome = harness
        .submit("write_chunks", encode(&(chunk_count,)), options)
        .await
        .expect("submit storage fixture");

    match outcome {
        SubmissionOutcome::Committed(receipt) => println!(
            "wrote {chunk_count} chunks at height {} in {:?}; tx={:?}",
            *receipt.height,
            started.elapsed(),
            receipt.tx_hash
        ),
        other => panic!("storage fixture did not commit: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires a funded deployed contract and live Groundhog node"]
async fn initializes_complete_world() {
    let harness = Harness::from_env(INTERFACE, VERSION);
    let gas = env_u64("GAME_OF_LIFE_TARGET_GAS", 100_000_000_000);
    let options = InvocationOptions {
        outer_transaction_gas_limit: env_u64("GAME_OF_LIFE_OUTER_GAS", gas + 10_000_000),
        target_call_gas_limit: gas,
        expiry: TransactionExpiry::Offset(1_000),
        receipt_timeout: Duration::from_secs(env_u64("GAME_OF_LIFE_TIMEOUT_SECONDS", 600)),
        receipt_poll_interval: Duration::from_secs(1),
    };

    let started = std::time::Instant::now();
    let outcome = harness
        .submit("initialize", encode(&(0u64, 64u32)), options)
        .await
        .expect("submit initialization");

    match outcome {
        SubmissionOutcome::Committed(receipt) => {
            println!(
                "initialized at height {} in {:?}; tx={:?}, events={}",
                *receipt.height,
                started.elapsed(),
                receipt.tx_hash,
                receipt.events.len()
            );
            assert_eq!(receipt.events.len(), 1);
            assert!(receipt.return_data.is_some());
            let metadata: WorldMetadata = decode_return(&receipt);
            assert_eq!(metadata.generation, 0);
            assert_eq!(metadata.population, 49_999_272);
            assert_eq!(
                metadata.state_digest,
                SHA256Hash::new([
                    0x85, 0xd7, 0x2e, 0x50, 0x01, 0x6b, 0xad, 0xaf, 0xcf, 0x3b, 0xc5, 0xc7, 0x04,
                    0x0d, 0x42, 0x90, 0x0b, 0x04, 0x17, 0xc3, 0xad, 0xc6, 0x72, 0x10, 0x15, 0xaa,
                    0x11, 0x47, 0xd6, 0x73, 0x3e, 0x05,
                ])
            );
        }
        other => panic!("initialization did not commit: {other:?}"),
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .map(|value| {
            value
                .parse()
                .unwrap_or_else(|error| panic!("invalid {name}={value}: {error}"))
        })
        .unwrap_or(default)
}
