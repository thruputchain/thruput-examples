use ctr::CounterClient;
use sdk::*;

static NONCE: SHA256Hash = sdk::sha256_static!(
    "CTR_WASM_NONCE"
);

/// Test the contract running as WASM in the executor.
///
/// Unlike `cargo test` (which runs natively with unwind),
/// the contract here is compiled to WASM and executed by
/// the mock executor — the same path as on-chain. A
/// contract fault (e.g. NNInt underflow) is a real abort,
/// not a caught Rust panic.
///
/// Use `cargo test` for fast iteration and error-path
/// testing. Use `groundhog test` to verify the contract
/// behaves correctly under real execution semantics.
#[test]
#[ignore = "requires WASM build — run via `groundhog test`"]
fn test_counter_wasm() {
    let contract = load_wasm_contract(
        "target/wasm32-unknown-unknown/release/\
         ctr.wasm",
    );
    let env = TestEnvironment::no_cost();
    let contract_hash =
        env.setup_create_contract(&contract);
    let call_addr = ContractAddress::named(
        "ctr_wasm",
    );

    let result = env.transact(|tx| {
        tx.call(&call_addr).run(|| {
            let addr = deploy_contract(
                &NONCE, &contract_hash,
            );
            let client =
                CounterClient::new(&addr);

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
