use counter::CounterClient;
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("COUNTER_RV32_NONCE");

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
    let contract = load_rv32_contract("../../target/thruput/counter.rv32a");
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
