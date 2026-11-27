//! The RV32 artifact in the mock executor: the same path as on chain, including the guest's
//! 64 KiB of memory. Build it first with `thruput build -p fhe --stack-size 16K` (or
//! `scripts/build-guest.sh`), then run `cargo test -p fhe --test test_rv32 -- --ignored`.
//! (`thruput test` would rebuild it with the default stack.) The mock's database is too small
//! for a whole evaluation key, so gates are checked on a node instead (`contracts/fhe/live.sh`).

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use fhe::FheClient;
use fhe_client::node::{GROUPS_PER_UPLOAD, POLYS_PER_UPLOAD};
use fhe_client::{Rng, SecretKey};
use fhe_core::Lwe;
use fhe_core::params::{KS_GROUP_BYTES, POLY_BYTES};
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
    let mut rng = Rng::from_phrase("rv32");
    let sk = SecretKey::generate(&mut rng);
    env.transact(|tx| {
        tx.call(&ContractAddress::named("owner"))
            .run(AssertUnwindSafe(|| {
                let addr = deploy_contract(&NONCE, &hash);
                let fhe = FheClient::new(&addr);
                assert_eq!(fhe.create_keyset(), 0);
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
            }))
    })
    .assert_success();
}
