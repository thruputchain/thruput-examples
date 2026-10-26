mod common;

use oracle_consumer::{ConsumerError, OracleConsumerClient};
use thruput_sdk::*;

#[test]
#[ignore = "requires RV32 build — run via `thruput test -p oracle-consumer`"]
fn reads_and_values_prices_through_guest_consumer() {
    let env = TestEnvironment::no_cost();
    let artifact = load_rv32_contract("../../target/thruput/oracle_consumer.rv32a");
    let hash = env.setup_create_contract(&artifact);
    let (oracle, consumer) = common::setup(&env, hash);
    env.transact(|tx| {
        tx.call(&ContractAddress::named("reader")).run(|| {
            let client = OracleConsumerClient::new(&consumer);
            assert_eq!(
                client.latest_price(&oracle, 1, 100),
                common::price().observation
            );
            assert_eq!(client.value(&oracle, 1, 15, 1, 100), 45_000_000_001);
            let error = client.try_latest_price(&oracle, 1, 99).unwrap_err();
            assert_eq!(error.try_as(), Some(ConsumerError::StaleObservation));
        })
    })
    .assert_success();
}
