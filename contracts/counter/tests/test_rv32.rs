use std::path::PathBuf;

use counter::{CounterClient, PingEvent};
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("COUNTER_RV32_NONCE");

fn counter_artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    // Cargo runs tests from the package directory; relative target paths are
    // resolved from the workspace root used by the documented CLI commands.
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/counter.rv32a")
}

/// Test the contract running as RV32 in the executor.
///
/// Unlike `cargo test` (which runs natively with unwind),
/// the contract here is compiled to RV32 and executed by
/// the mock executor — the same path as on-chain. A
/// contract fault (e.g. Balance underflow) is a real abort,
/// not a caught Rust panic.
///
/// Use `cargo test` for fast iteration and error-path
/// testing. Use `thruput test` to verify the contract
/// behaves correctly under real execution semantics.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn test_counter_rv32() {
    let contract = load_rv32_contract(counter_artifact());
    let env = TestEnvironment::no_cost();
    let contract_hash = env.setup_create_contract(&contract);
    let call_addr = ContractAddress::named("counter_rv32");

    let result = env.transact(|tx| {
        tx.call(&call_addr).run(|| {
            let addr = deploy_contract(&NONCE, &contract_hash);
            let client = CounterClient::new(&addr);

            assert_eq!(client.get(), 0);
            client.initialize(10);
            assert_eq!(client.get(), 10);

            client.increment(5);
            assert_eq!(client.get(), 15);

            client.decrement(3);
            assert_eq!(client.get(), 12);
        })
    });

    result.assert_success();
}

#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn test_counter_event_rv32() {
    let contract = load_rv32_contract(counter_artifact());
    let env = TestEnvironment::no_cost();
    let contract_hash = env.setup_create_contract(&contract);
    let tag = 42u64;

    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("counter_event_rv32"))
            .run(|| {
                let addr = deploy_contract(&NONCE, &contract_hash);
                CounterClient::new(&addr).ping(tag);
            })
    });

    result.assert_success();
    result.assert_event_count(1);
    result.assert_event::<PingEvent>(0, |event| {
        assert_eq!(event.num_topics(), 2);
        let expected: Topic = tag.into_topic().into();
        assert_eq!(event.topic(1), Some(&expected));
    });
}
