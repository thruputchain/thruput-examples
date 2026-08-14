use groundhog_signing::{
    BuildDevWalletDoActionTransaction, LocalSigner, SignTransactionParams,
    build_dev_wallet_do_action_transaction, dev_wallet_do_action_calldata,
    encode_signed_transaction_xdr, encode_transaction_xdr, sign_transaction, transaction_hash,
};
use groundhog_testkit::xdr::contract::ContractEntrypointID;
use groundhog_testkit::xdr::types::{ContractAddress, Signature};
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../src/transactions/fixtures/dev-wallet-transaction-v1.json");

#[test]
fn rust_signing_matches_the_browser_wallet_vector() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture must be valid JSON");
    let inputs = &fixture["inputs"];
    let expected = &fixture["expected"];
    let secret = fixed_bytes::<32>(text(inputs, "privateKeyHex"));
    let wallet_address = ContractAddress::from(fixed_bytes::<32>(text(inputs, "walletAddressHex")));
    let wallet_entrypoint =
        ContractEntrypointID::from(fixed_bytes::<8>(text(inputs, "walletEntrypointHex")));
    let target_address = ContractAddress::from(fixed_bytes::<32>(text(inputs, "targetAddressHex")));
    let target_entrypoint =
        ContractEntrypointID::from(fixed_bytes::<8>(text(inputs, "targetEntrypointHex")));
    let target_calldata = hex_bytes(text(inputs, "targetCalldataHex"));
    let target_gas_limit = integer(inputs, "targetGasLimit");

    let wallet_calldata = dev_wallet_do_action_calldata(
        target_address,
        target_entrypoint,
        target_gas_limit,
        &target_calldata,
    )
    .expect("wallet calldata must encode");
    let transaction = build_dev_wallet_do_action_transaction(BuildDevWalletDoActionTransaction {
        wallet_address,
        wallet_entrypoint,
        target_address,
        target_entrypoint,
        target_calldata: &target_calldata,
        gas_limit: integer(inputs, "outerGasLimit"),
        target_gas_limit,
        block_expiry_height: integer(inputs, "blockExpiryHeight") as i64,
        nonce: integer(inputs, "nonce"),
    })
    .expect("transaction must build");
    let unsigned_xdr = encode_transaction_xdr(&transaction).expect("transaction must encode");
    let hash = transaction_hash(&transaction).expect("transaction must hash");
    let signed = sign_transaction(
        transaction,
        &LocalSigner::from_secret_key(secret),
        SignTransactionParams::default(),
    )
    .expect("transaction must sign");
    let signed_xdr =
        encode_signed_transaction_xdr(&signed).expect("signed transaction must encode");
    let signature = match &signed.signatures.0[0].signature {
        Signature::Ed25519 { ed25519 } => ed25519.as_ref(),
        _ => panic!("fixture signer must produce an Ed25519 signature"),
    };

    assert_eq!(
        hex_prefixed(&wallet_calldata),
        text(expected, "walletCalldataHex")
    );
    assert_eq!(
        hex_prefixed(&unsigned_xdr),
        text(expected, "unsignedTransactionXdrHex")
    );
    assert_eq!(
        hex_prefixed(hash.as_ref()),
        text(expected, "canonicalTransactionHashHex")
    );
    assert_eq!(hex_prefixed(signature), text(expected, "signatureHex"));
    assert_eq!(
        hex_prefixed(&signed_xdr),
        text(expected, "signedTransactionXdrHex")
    );
    assert_eq!(
        signed.signatures.0[0].public_key_id,
        integer(inputs, "publicKeyId") as u32
    );
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("fixture field {key} must be a string"))
}

fn integer(value: &Value, key: &str) -> u64 {
    text(value, key)
        .parse()
        .unwrap_or_else(|_| panic!("fixture field {key} must be an integer string"))
}

fn hex_bytes(value: &str) -> Vec<u8> {
    hex::decode(
        value
            .strip_prefix("0x")
            .expect("fixture hex must start with 0x"),
    )
    .expect("fixture hex must decode")
}

fn fixed_bytes<const N: usize>(value: &str) -> [u8; N] {
    hex_bytes(value)
        .try_into()
        .unwrap_or_else(|_| panic!("fixture value must contain {N} bytes"))
}

fn hex_prefixed(value: &[u8]) -> String {
    format!("0x{}", hex::encode(value))
}
