//! The contract in the native mock environment: keyset funding, upload and its checks,
//! ciphertexts, NOT, the refusals of a gate on an unsealed keyset or a bad input, and the abuse
//! cases: a stranger cannot store under, compute on, or withdraw from someone else's keyset.
//!
//! The mock environment caps what one transaction may write (about 16 MiB), and its database
//! holds less than a whole evaluation key (63 MB), so gates themselves are tested on a node
//! (`tests/testkit_gate.rs`, run by `contracts/fhe/live.sh`), and the arithmetic natively in
//! `fhe-client`'s tests, through the same step code.

use std::panic::AssertUnwindSafe;

use fhe::{FheClient, FheError, register_mock_contract};
use fhe_client::{Rng, SecretKey};
use fhe_core::params::*;
use fhe_core::{Gate, Lwe};
use thruput_erc20_if::ERC20Client;
use thruput_sdk::genesis_addresses::ADDRESS_NATIVE_TOKEN;
use thruput_sdk::*;

static NONCE: SHA256Hash = thruput_sdk::sha256_static!("FHE_NONCE");

/// Native-token base units given to each test account.
const GRANT: i64 = 1_000_000_000;
/// What the owner pays into keyset 0: enough for a few pieces and ciphertexts, not a whole key.
const FUNDS: u128 = 400_000;

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

/// Allow the contract to take `amount` of the caller's native tokens.
fn allow(fhe: &ContractAddress, amount: u128) {
    ERC20Client::new(&ADDRESS_NATIVE_TOKEN).adjust_allowance(fhe, amount as i128);
}

#[test]
fn keysets_funds_ciphertexts_and_checks() {
    // The hosted network's storage-value limit; the local node's default is 1,024 bytes.
    let env = TestEnvironment::builder()
        .no_cost()
        .with_max_bytestring_len(4096)
        .build();
    let code = register_mock_contract(&env);
    let owner = ContractAddress::named("owner");
    let other = ContractAddress::named("other");
    env.setup_grant_storage_tokens(&ADDRESS_NATIVE_TOKEN, GRANT);
    env.setup_grant_storage_tokens(&owner, GRANT);
    env.setup_grant_storage_tokens(&other, GRANT);
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
            // Creating a keyset takes its funds from the creator, on an allowance.
            assert!(fhe.try_create_keyset(FUNDS).is_err());
        }))
    })
    .assert_success();
    env.advance_block();

    env.transact(|tx| {
        tx.call(&owner).run(AssertUnwindSafe(|| {
            let fhe = FheClient::new(&addr);
            allow(&addr, 10 * FUNDS);
            assert_eq!(fhe.create_keyset(FUNDS), 0);
            let spent = 3 * deposit(64);
            assert_eq!(fhe.keyset_funds(0), FUNDS - spent);

            expect_error(
                fhe.try_upload_bsk(0, 0, &[0u8; 100]),
                FheError::InvalidUpload,
            );
            expect_error(
                fhe.try_upload_bsk(0, BSK_POLYS as u32 - 1, &[poly, poly].concat()),
                FheError::InvalidUpload,
            );
            // An index past the end cannot wrap around, on a 32-bit guest either.
            expect_error(
                fhe.try_upload_bsk(0, u32::MAX, &poly),
                FheError::InvalidUpload,
            );
            expect_error(fhe.try_upload_ksk(0, 0, &poly), FheError::InvalidUpload);
            expect_error(
                fhe.try_upload_bsk(0, 0, &[0xff; POLY_BYTES]),
                FheError::InvalidKey,
            );
            fhe.upload_bsk(0, 0, &[poly, poly, poly].concat());
            fhe.upload_ksk(0, KS_GROUPS as u32 - 2, &[group, group].concat());
            // Uploading a piece again replaces it without counting or charging it twice.
            fhe.upload_bsk(0, 2, &poly);
            assert_eq!(fhe.uploaded(0), 5);
            let spent = spent + 3 * deposit(POLY_BYTES) + 2 * deposit(KS_GROUP_BYTES);
            assert_eq!(fhe.keyset_funds(0), FUNDS - spent);
            expect_error(fhe.try_seal(0), FheError::Incomplete);
            expect_error(fhe.try_upload_bsk(7, 0, &poly), FheError::NotFound);

            // The funds run out before anything is stored, not partway through.
            let left = fhe.keyset_funds(0);
            let too_many = (left / deposit(POLY_BYTES) + 1) as usize;
            assert!(too_many <= 6, "the test's funds cover only a few pieces");
            let data = vec![7u8; too_many * POLY_BYTES];
            expect_error(fhe.try_upload_bsk(0, 100, &data), FheError::Underfunded);
            assert_eq!(fhe.uploaded(0), 5);
            // The owner can take unspent funds back, and add more.
            fhe.withdraw(0, 1000);
            assert_eq!(fhe.keyset_funds(0), left - 1000);
            fhe.fund_keyset(0, 1000);
            assert_eq!(fhe.keyset_funds(0), left);
            // Enough for the ciphertexts below.
            fhe.fund_keyset(0, FUNDS);
        }))
    })
    .assert_success();
    env.advance_block();

    env.transact(|tx| {
        tx.call(&other).run(AssertUnwindSafe(|| {
            let fhe = FheClient::new(&addr);
            // A stranger can read the owner's keyset, but not spend from it or store under it.
            assert!(!fhe.get_keyset(0).sealed);
            assert_eq!(fhe.get_keyset(0).owner, owner);
            expect_error(fhe.try_upload_bsk(0, 0, &poly), FheError::NotOwner);
            expect_error(fhe.try_seal(0), FheError::NotOwner);
            expect_error(fhe.try_withdraw(0, 1), FheError::NotOwner);
            let ct = sk.encrypt(true, &mut rng).to_bytes();
            expect_error(fhe.try_put_ciphertext(0, &ct), FheError::NotOwner);
            expect_error(fhe.try_constant(0, true), FheError::NotOwner);
            // A keyset of its own, paid with its own funds.
            allow(&addr, FUNDS);
            assert_eq!(fhe.create_keyset(FUNDS), 1);
            fhe.put_ciphertext(1, &ct);
        }))
    })
    .assert_success();
    env.advance_block();

    env.transact(|tx| {
        tx.call(&owner).run(AssertUnwindSafe(|| {
            let fhe = FheClient::new(&addr);
            expect_error(
                fhe.try_put_ciphertext(0, &[0u8; 10]),
                FheError::InvalidCiphertext,
            );
            let mut bad = Lwe::zero().to_bytes();
            *bad.last_mut().unwrap() = 0xff; // padding bits set
            expect_error(fhe.try_put_ciphertext(0, &bad), FheError::InvalidCiphertext);
            expect_error(fhe.try_put_ciphertext(9, &bad), FheError::NotFound);

            for bit in [false, true] {
                let id = fhe.put_ciphertext(0, &sk.encrypt(bit, &mut rng).to_bytes());
                let stored = fhe.get_ciphertext(id);
                assert_eq!(&stored[..8], &0u64.to_le_bytes());
                assert_eq!(decrypt(&sk, &stored), bit);
                assert_eq!(decrypt(&sk, &fhe.get_ciphertext(fhe.not(id))), !bit);
                assert_eq!(decrypt(&sk, &fhe.get_ciphertext(fhe.constant(0, bit))), bit);
            }
            let x = fhe.put_ciphertext(0, &sk.encrypt(true, &mut rng).to_bytes());
            let y = fhe.put_ciphertext(0, &sk.encrypt(true, &mut rng).to_bytes());
            // Ciphertext 0 belongs to the other account's keyset 1.
            expect_error(fhe.try_not(0), FheError::NotOwner);
            expect_error(
                fhe.try_start_gate(Gate::Nand as u32, x, x),
                FheError::SameInput,
            );
            expect_error(
                fhe.try_start_gate(Gate::Nand as u32, x, y),
                FheError::NotSealed,
            );
            expect_error(
                fhe.try_start_gate(Gate::Nand as u32, x, 0),
                FheError::KeysetMismatch,
            );
            expect_error(fhe.try_start_gate(9, x, y), FheError::InvalidGate);
            expect_error(fhe.try_start_gate(0, x, 99), FheError::NotFound);
            expect_error(fhe.try_crank(0), FheError::NotFound);
        }))
    })
    .assert_success();
}
