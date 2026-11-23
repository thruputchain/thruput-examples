use standard_token_factory_if::{
    FactoryConfig, StandardTokenFactoryClient, StandardTokenInitializerClient, TokenCreated,
};
use thruput_sdk::{ContractAddress, Named, SHA256Hash, TestEnvironment, encode_xdr, log_event};

#[test]
fn generated_clients_compile() {
    let address = ContractAddress::named("generated-clients");
    let _factory = StandardTokenFactoryClient::new(&address);
    let _initializer = StandardTokenInitializerClient::new(&address);
}

#[test]
fn factory_config_roundtrips() {
    let config = FactoryConfig {
        token_code_hash: SHA256Hash::from([0x44; 32]),
        required_token_funding: 123,
        native_token: ContractAddress::from([0x55; 32]),
        creation_fee: 7,
        fee_recipient: Some(ContractAddress::from([0x66; 32])),
    };

    let encoded = encode_xdr(&config).expect("config encodes");
    let decoded: FactoryConfig = thruput_sdk::xdr::cxs::decode(&encoded).expect("config decodes");
    assert_eq!(decoded, config);
}

#[test]
fn token_created_topics_and_payload_roundtrip_through_host_event() {
    let event = TokenCreated {
        token: ContractAddress::from([0x11; 32]),
        creator: ContractAddress::from([0x22; 32]),
        administrator: ContractAddress::from([0x33; 32]),
        initial_holder: ContractAddress::from([0x44; 32]),
        initial_supply: 99,
        name: None,
        symbol: None,
        decimals: Some(9),
        token_code_hash: SHA256Hash::from([0x55; 32]),
    };

    let env = TestEnvironment::no_cost();
    let result = env.transact(|tx| {
        tx.call(&ContractAddress::named("event-host"))
            .run(|| log_event(&event))
    });

    result.assert_success();
    result.assert_event::<TokenCreated>(0, |emitted| {
        assert_eq!(emitted.topic(0).unwrap(), TokenCreated::SIGNATURE);
        assert_eq!(emitted.topic(1).unwrap(), &[0x11; 32]);
        assert_eq!(emitted.topic(2).unwrap(), &[0x22; 32]);
        assert_eq!(
            emitted.payload().administrator,
            ContractAddress::from([0x33; 32])
        );
        assert_eq!(
            emitted.payload().initial_holder,
            ContractAddress::from([0x44; 32])
        );
        assert_eq!(emitted.payload().initial_supply, 99);
        assert_eq!(emitted.payload().name, None);
        assert_eq!(emitted.payload().symbol, None);
        assert_eq!(emitted.payload().decimals, Some(9));
        assert_eq!(
            emitted.payload().token_code_hash,
            SHA256Hash::from([0x55; 32])
        );
    });
}
