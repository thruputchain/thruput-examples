use sdk::{ContractAddress, Named, SHA256Hash, TestEnvironment};
use serde_json::Value;
use standard_token_if::{deployment_nonce, predicted_token};

fn parse_32(value: &str) -> [u8; 32] {
    hex::decode(value)
        .expect("fixture value is hex")
        .try_into()
        .expect("fixture value is 32 bytes")
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/address-vectors.json"))
        .expect("address vector fixture is valid JSON")
}

fn child_address(vector: &Value) -> &str {
    vector["child_address"].as_str().unwrap()
}

#[test]
fn deterministic_vectors_match_language_neutral_fixture() {
    let fixture = fixture();
    let vectors = fixture.as_array().expect("fixture is an array");
    let env = TestEnvironment::no_cost();

    for vector in vectors {
        let factory = ContractAddress::from(parse_32(vector["factory"].as_str().unwrap()));
        let creator = ContractAddress::from(parse_32(vector["creator"].as_str().unwrap()));
        let nonce = SHA256Hash::from(parse_32(vector["application_nonce"].as_str().unwrap()));
        let token_hash = SHA256Hash::from(parse_32(vector["token_hash"].as_str().unwrap()));
        let expected_nonce = parse_32(vector["deployment_nonce"].as_str().unwrap());
        let expected_token =
            ContractAddress::from(parse_32(vector["child_address"].as_str().unwrap()));

        env.transact(|tx| {
            tx.call(&ContractAddress::named("vector-host")).run(|| {
                assert_eq!(deployment_nonce(&creator, &nonce).as_ref(), &expected_nonce);
                assert_eq!(
                    predicted_token(&factory, &creator, &nonce, &token_hash),
                    expected_token
                );
            })
        })
        .assert_success();
    }
}

#[test]
fn different_factories_derive_different_children() {
    let fixture = fixture();
    let vectors = fixture.as_array().unwrap();

    assert_ne!(child_address(&vectors[0]), child_address(&vectors[1]));
}

#[test]
fn different_creators_derive_different_children() {
    let fixture = fixture();
    let vectors = fixture.as_array().unwrap();

    assert_ne!(child_address(&vectors[0]), child_address(&vectors[2]));
}

#[test]
fn different_application_nonces_derive_different_children() {
    let fixture = fixture();
    let vectors = fixture.as_array().unwrap();

    assert_ne!(child_address(&vectors[0]), child_address(&vectors[3]));
}
