//! The RV32 artifact in the mock executor: the same path as on chain, including the guest's
//! 64 KiB of memory. Build it first with `thruput build -p fhe --stack-size 16K` (or
//! `scripts/build-guest.sh`), then run `cargo test -p fhe --test test_rv32 -- --ignored`.
//! (`thruput test` would rebuild it with the default stack.) The mock's database is too small
//! for a whole evaluation key, so gates are checked on a node instead (`contracts/fhe/live.sh`).

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use fhe::{FheClient, FheError};
use fhe_client::node::{GROUPS_PER_UPLOAD, POLYS_PER_UPLOAD};
use fhe_client::{Rng, SecretKey};
use fhe_core::Lwe;
use fhe_core::params::{KS_GROUP_BYTES, POLY_BYTES, StorageRates};
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("FHE_RV32_NONCE");

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/fhe.rv32a")
}

#[test]
#[ignore = "requires the RV32 build; see the comment at the top"]
fn ciphertexts_and_uploads_rv32() {
    let contract = load_rv32_contract(artifact());
    let env = TestEnvironment::builder()
        .no_cost()
        .with_max_bytestring_len(4096)
        .build();
    let hash = env.setup_create_contract(&contract);
    let owner = ContractAddress::named("owner");
    env.setup_grant_storage_tokens(&ADDRESS_NATIVE_TOKEN, 1_000_000_000);
    env.setup_grant_storage_tokens(&owner, 1_000_000_000);
    let mut rng = Rng::from_phrase("rv32");
    let sk = SecretKey::generate(&mut rng);
    env.transact(|tx| {
        tx.call(&owner).run(AssertUnwindSafe(|| {
            let addr = deploy_contract(&NONCE, &hash);
            let fhe = FheClient::new(&addr);
            // Small rates, so that the whole key's reserved deposit stays cheap.
            let rates = StorageRates { item: 12, byte: 1 };
            fhe.initialize(rates.item, rates.byte);
            let funds = rates.keyset() + 1_000_000;
            ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(&addr, funds as i128);
            assert_eq!(fhe.create_keyset(funds), 0);
            let id = fhe.put_ciphertext(0, &sk.encrypt(true, &mut rng).to_bytes());
            let not = fhe.get_ciphertext(fhe.not(id));
            assert!(!sk.decrypt(&Lwe::from_bytes(&not[8..]).unwrap()));
            // The node driver's upload sizes fit the guest's memory beside the calldata.
            fhe.upload_bsk(0, 0, &vec![1u8; POLYS_PER_UPLOAD * POLY_BYTES]);
            fhe.upload_ksk(0, 0, &vec![1u8; GROUPS_PER_UPLOAD * KS_GROUP_BYTES]);
            assert_eq!(
                fhe.uploaded(0),
                (POLYS_PER_UPLOAD + GROUPS_PER_UPLOAD) as u64
            );
            // On a 32-bit guest, an index near u32::MAX must not wrap past the bound.
            let refused = fhe.try_upload_bsk(0, u32::MAX, &[1u8; POLY_BYTES]);
            assert_eq!(refused.unwrap_err().try_as(), Some(FheError::InvalidUpload));
        }))
    })
    .assert_success();
}
