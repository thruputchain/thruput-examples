//! The contract in the native mock environment: keyset upload and its checks, ciphertexts, NOT,
//! and the refusals of a gate on an unsealed keyset or a bad input.
//!
//! The mock's in-memory database holds less than a whole evaluation key (63 MB), so gates
//! themselves are tested on a node (`tests/testkit_gate.rs`, run by `contracts/fhe/live.sh`),
//! and the arithmetic natively in `fhe-client`'s tests, through the same step code.

use std::panic::AssertUnwindSafe;

use fhe::{FheClient, FheError, register_mock_contract};
use fhe_client::{Rng, SecretKey};
use fhe_core::params::*;
use fhe_core::{Gate, Lwe};
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("FHE_NONCE");

fn expect_error<T: std::fmt::Debug>(result: Result<T, CallError>, want: FheError) {
    match result {
        Ok(v) => panic!("expected {want:?}, got {v:?}"),
        Err(err) => {
            let message = format!("expected {want:?}, got {err:?}");
            assert_eq!(err.try_as(), Some(want), "{message}");
        }
    }
}

fn decrypt(sk: &SecretKey, stored: &[u8]) -> bool {
    sk.decrypt(&Lwe::from_bytes(&stored[8..]).expect("a packed ciphertext"))
}

#[test]
fn keysets_ciphertexts_and_checks() {
    // The hosted network's storage-value limit; the local node's default is 1,024 bytes.
    let env = TestEnvironment::builder()
        .no_cost()
        .with_max_bytestring_len(4096)
        .build();
    let code = register_mock_contract(&env);
    let owner = ContractAddress::named("owner");
    let other = ContractAddress::named("other");
    let mut rng = Rng::from_phrase("fhe contract tests");
    // A secret key is enough to make ciphertexts; the evaluation key here is a stand-in.
    let sk = SecretKey::generate(&mut rng);
    let poly = [7u8; POLY_BYTES];
    let group = [9u8; KS_GROUP_BYTES];

    let mut addr = owner;
    env.transact(|tx| {
        tx.call(&owner).run(AssertUnwindSafe(|| {
            addr = deploy_contract(&NONCE, code.as_hash());
            let fhe = FheClient::new(&addr);
            assert_eq!(fhe.create_keyset(), 0);
            assert_eq!(fhe.create_keyset(), 1);
            expect_error(
                fhe.try_upload_bsk(0, 0, &[0u8; 100]),
                FheError::InvalidUpload,
            );
            expect_error(
                fhe.try_upload_bsk(0, BSK_POLYS as u32 - 1, &[poly, poly].concat()),
                FheError::InvalidUpload,
            );
            expect_error(fhe.try_upload_ksk(0, 0, &poly), FheError::InvalidUpload);
            fhe.upload_bsk(0, 0, &[poly, poly, poly].concat());
            fhe.upload_ksk(0, KS_GROUPS as u32 - 2, &[group, group].concat());
            // Uploading a piece again replaces it without counting it twice.
            fhe.upload_bsk(0, 2, &poly);
            assert_eq!(fhe.uploaded(0), 5);
            expect_error(fhe.try_seal(0), FheError::Incomplete);
            expect_error(fhe.try_upload_bsk(7, 0, &poly), FheError::NotFound);
        }))
    })
    .assert_success();
    env.advance_block();

    env.transact(|tx| {
        tx.call(&other).run(AssertUnwindSafe(|| {
            let fhe = FheClient::new(&addr);
            expect_error(fhe.try_upload_bsk(0, 0, &poly), FheError::NotOwner);
            expect_error(fhe.try_seal(0), FheError::NotOwner);
            assert!(!fhe.get_keyset(0).sealed);
            assert_eq!(fhe.get_keyset(0).owner, owner);

            expect_error(
                fhe.try_put_ciphertext(0, &[0u8; 10]),
                FheError::InvalidCiphertext,
            );
            let mut bad = Lwe::zero().to_bytes();
            *bad.last_mut().unwrap() = 0xff; // padding bits set
            expect_error(fhe.try_put_ciphertext(0, &bad), FheError::InvalidCiphertext);
            expect_error(
                fhe.try_put_ciphertext(9, &Lwe::zero().to_bytes()),
                FheError::NotFound,
            );

            for bit in [false, true] {
                let id = fhe.put_ciphertext(0, &sk.encrypt(bit, &mut rng).to_bytes());
                let stored = fhe.get_ciphertext(id);
                assert_eq!(&stored[..8], &0u64.to_le_bytes());
                assert_eq!(decrypt(&sk, &stored), bit);
                assert_eq!(decrypt(&sk, &fhe.get_ciphertext(fhe.not(id))), !bit);
                assert_eq!(decrypt(&sk, &fhe.get_ciphertext(fhe.constant(0, bit))), bit);
            }
            let x = fhe.put_ciphertext(0, &sk.encrypt(true, &mut rng).to_bytes());
            let y = fhe.put_ciphertext(1, &sk.encrypt(true, &mut rng).to_bytes());
            expect_error(
                fhe.try_start_gate(Gate::Nand as u32, x, x),
                FheError::NotSealed,
            );
            expect_error(
                fhe.try_start_gate(Gate::Nand as u32, x, y),
                FheError::KeysetMismatch,
            );
            expect_error(fhe.try_start_gate(9, x, x), FheError::InvalidGate);
            expect_error(fhe.try_start_gate(0, x, 99), FheError::NotFound);
            expect_error(fhe.try_crank(0), FheError::NotFound);
        }))
    })
    .assert_success();
}
