use oracle_consumer::oracle::{PriceRecord, PriceUpdate};
use thruput_sdk::{storage::Value, *};

// Test-only publisher: deliberately accepts invalid data to exercise the consumer.
#[storage(domain = "oracle-consumer-test-fixture")]
pub struct OracleFixture {
    record: Value<PriceRecord>,
}

#[contract_exception]
pub enum FixtureError {
    MissingPrice = 1,
    UnknownFeed = 2,
}

// Match the relay's interface name as well as its method signature and version.
#[contract(interface = "Contract", version = "0.1.0", client = OracleFixtureClient, throws = FixtureError)]
impl OracleFixture {
    pub fn set_price(&mut self, record: PriceRecord) {
        self.record.set_exclusive(&record);
    }

    pub fn get_price(&self, feed_id: u32) -> PriceRecord {
        ensure(feed_id == 1, FixtureError::UnknownFeed);
        self.record
            .try_get()
            .none_if_missing()
            .unwrap_or_else(|| throw(FixtureError::MissingPrice))
    }
}

pub fn price() -> PriceRecord {
    let now = get_block_timepoint().into_inner() / 1_000_000_000;
    PriceRecord {
        observation: PriceUpdate {
            feed_id: 1,
            price: 30_000_000_001,
            decimals: 6,
            timestamp: now - 100,
            round: 42,
        },
        accepted_at: now,
    }
}

pub fn setup(
    env: &TestEnvironmentHandle,
    consumer_hash: SHA256Hash,
) -> (ContractAddress, ContractAddress) {
    let oracle_hash = *env.register_mock(OracleFixture::__mock).as_hash();
    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("oracle-consumer-tests"))
            .run(|| {
                let oracle = deploy_contract(&sha256_static!("oracle"), &oracle_hash);
                let consumer = deploy_contract(&sha256_static!("consumer"), &consumer_hash);
                OracleFixtureClient::new(&oracle).set_price(price());
                (oracle, consumer, get_block_timepoint())
            })
    });
    result.assert_success();
    let (oracle, consumer, timepoint) = result.assert_return_as();
    // Commit setup without letting wall-clock time age the boundary observation.
    env.advance_block_at(timepoint);
    (oracle, consumer)
}
