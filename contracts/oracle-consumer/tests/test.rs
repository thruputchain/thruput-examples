mod common;

use common::*;
use oracle_consumer::ConsumerError;
use thruput_sdk::*;

fn run(
    test: impl FnOnce(&ContractAddress, &oracle_consumer::OracleConsumerClient) + std::panic::UnwindSafe,
) {
    let env = TestEnvironment::no_cost();
    let hash = *oracle_consumer::register_mock_contract(&env).as_hash();
    let (oracle, consumer) = setup(&env, hash);
    env.transact(|tx| {
        tx.call(&ContractAddress::named("reader")).run(|| {
            test(
                &oracle,
                &oracle_consumer::OracleConsumerClient::new(&consumer),
            );
        })
    })
    .assert_success();
}

#[test]
fn read_interface_matches_relay_entrypoint() {
    run(|oracle, _| {
        // Pinned to src/generated/oracle.ts at relay revision 286c485.
        let config = InvokeConfig::default();
        let record: oracle_consumer::oracle::PriceRecord =
            call::try_call_raw_with::<_, _, core::convert::Infallible>(
                oracle,
                contract::ContractEntrypointID::from_u64(0x8c8947ffd495b451),
                config.gas_limit,
                &1_u32,
                config.flags,
                |exception| exception.re_throw(),
            )
            .or_re_throw();
        assert_eq!(
            oracle_consumer::oracle::OracleClient::new(oracle).get_price(1),
            record
        );
    });
}

#[test]
fn reads_price_and_preserves_source_metadata_at_age_limit() {
    run(|oracle, consumer| {
        assert_eq!(consumer.latest_price(oracle, 1, 100), price().observation);
    });
}

#[test]
fn values_fractional_tokens_and_rounds_down() {
    run(|oracle, consumer| {
        // 1.5 tokens at 30,000.000001 USD: 45,000.000001 USD, rounded down.
        assert_eq!(consumer.value(oracle, 1, 15, 1, 100), 45_000_000_001);
    });
}

#[test]
fn stale_source_is_rejected_even_when_just_published() {
    run(|oracle, consumer| {
        let error = consumer.try_latest_price(oracle, 1, 99).unwrap_err();
        assert_eq!(error.try_as(), Some(ConsumerError::StaleObservation));
    });
}

#[test]
fn future_source_is_rejected() {
    run(|oracle, consumer| {
        let mut record = price();
        record.observation.timestamp = record.accepted_at + 1;
        OracleFixtureClient::new(oracle).set_price(record);
        let error = consumer.try_latest_price(oracle, 1, 100).unwrap_err();
        assert_eq!(error.try_as(), Some(ConsumerError::FutureObservation));
    });
}

#[test]
fn unknown_feed_error_propagates_from_oracle() {
    run(|oracle, consumer| {
        let error = consumer.try_latest_price(oracle, 2, 100).unwrap_err();
        assert_eq!(error.try_as(), Some(FixtureError::UnknownFeed));
    });
}

#[test]
fn missing_price_error_propagates_from_oracle() {
    let env = TestEnvironment::no_cost();
    let oracle_hash = *env.register_mock(OracleFixture::__mock).as_hash();
    let consumer_hash = *oracle_consumer::register_mock_contract(&env).as_hash();
    env.transact(|tx| {
        tx.call(&ContractAddress::named("reader")).run(|| {
            let oracle = deploy_contract(&sha256_static!("empty-oracle"), &oracle_hash);
            let consumer = deploy_contract(&sha256_static!("consumer"), &consumer_hash);
            let error = oracle_consumer::OracleConsumerClient::new(&consumer)
                .try_latest_price(&oracle, 1, 100)
                .unwrap_err();
            assert_eq!(error.try_as(), Some(FixtureError::MissingPrice));
        })
    })
    .assert_success();
}

#[test]
fn invalid_observations_are_rejected() {
    run(|oracle, consumer| {
        for field in ["price", "negative-price", "timestamp", "round", "feed"] {
            let mut record = price();
            match field {
                "price" => record.observation.price = 0,
                "negative-price" => record.observation.price = -1,
                "timestamp" => record.observation.timestamp = 0,
                "round" => record.observation.round = 0,
                "feed" => record.observation.feed_id = 2,
                _ => unreachable!(),
            }
            OracleFixtureClient::new(oracle).set_price(record);
            let error = consumer.try_latest_price(oracle, 1, 100).unwrap_err();
            assert_eq!(
                error.try_as(),
                Some(ConsumerError::InvalidObservation),
                "{field}"
            );
        }
    });
}

#[test]
fn invalid_feed_and_amount_precision_are_rejected() {
    run(|oracle, consumer| {
        let error = consumer.try_value(oracle, 1, 1, 19, 100).unwrap_err();
        assert_eq!(error.try_as(), Some(ConsumerError::InvalidPrecision));
        let mut record = price();
        record.observation.decimals = 19;
        OracleFixtureClient::new(oracle).set_price(record);
        let error = consumer.try_latest_price(oracle, 1, 100).unwrap_err();
        assert_eq!(error.try_as(), Some(ConsumerError::InvalidPrecision));
    });
}

#[test]
fn wide_intermediate_succeeds_when_final_value_fits() {
    run(|oracle, consumer| {
        let mut record = price();
        record.observation.price = 10;
        OracleFixtureClient::new(oracle).set_price(record);
        assert_eq!(consumer.value(oracle, 1, u128::MAX, 1, 100), u128::MAX);
    });
}

#[test]
fn final_value_overflow_is_rejected() {
    run(|oracle, consumer| {
        let error = consumer
            .try_value(oracle, 1, u128::MAX, 0, 100)
            .unwrap_err();
        assert_eq!(error.try_as(), Some(ConsumerError::Overflow));
    });
}

#[test]
fn zero_amount_has_zero_value() {
    run(|oracle, consumer| assert_eq!(consumer.value(oracle, 1, 0, 18, 100), 0));
}
