//! The README's demo against a deployed FHE contract, on any network:
//!
//! ```text
//! fhe-demo address          # the signer's account address, to fund
//! fhe-demo keyset           # create, upload and seal the demo keyset; prints its id
//! fhe-demo nand KEYSET X Y  # encrypt bits X and Y, evaluate NAND on chain, decrypt
//! fhe-demo adder KEYSET A B C
//! fhe-demo decrypt ID       # read a stored ciphertext and decrypt it with the demo key
//! ```
//!
//! Configuration comes from the environment: `THRUPUT_RPC_URL`, `THRUPUT_NETWORK_HASH`
//! (optional: refuse to sign for any other network), `FHE_CONTRACT` (the contract's address) and
//! `FHE_SIGNER` (a file holding the base58 secret
//! seed of a funded key, as `thruput keys export NAME -y` writes it; it is never printed).
//!
//! The demo keyset's secret key is derived from [`DEMO_PHRASE`], which is public: anyone can
//! decrypt what is encrypted under it. It demonstrates the mechanics and protects nothing.

use std::time::Instant;

use fhe_client::node::{Account, Fhe, Result};
use fhe_client::{Rng, SecretKey};
use fhe_core::Gate;
use fhe_core::params::{JOB_DEPOSIT, KEY_DEPOSIT, LWE_BYTES, deposit};
use thruput_xdr::base58;
use thruput_xdr::types::ContractAddress;

/// The public seed of the demo keyset's secret key. A demo key: it protects nothing.
pub const DEMO_PHRASE: &str = "thruput-examples fhe demo key v1 (public, protects nothing)";

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name}; see the program's doc comment"))
}

fn bit(arg: Option<&String>) -> bool {
    match arg.map(String::as_str) {
        Some("0") => false,
        Some("1") => true,
        _ => panic!("expected a bit, 0 or 1"),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let contract = ContractAddress::from(
        base58::decode_fixed::<32>(&env("FHE_CONTRACT")).expect("FHE_CONTRACT is a base58 address"),
    );
    // `decrypt` only reads, so it needs no key; any seed will do for its unused signer.
    let secret: [u8; 32] = match std::env::var("FHE_SIGNER") {
        Ok(path) => {
            let seed = std::fs::read_to_string(path).expect("read FHE_SIGNER");
            base58::decode_fixed::<32>(seed.trim())
                .expect("FHE_SIGNER holds a base58 seed, as `thruput keys export NAME -y` writes")
        }
        Err(_) if args.first().map(String::as_str) == Some("decrypt") => [1; 32],
        Err(_) => panic!("set FHE_SIGNER; see the program's doc comment"),
    };

    if let Err(e) = run(&args, contract, secret).await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn run(args: &[String], contract: ContractAddress, secret: [u8; 32]) -> Result<()> {
    let network = std::env::var("THRUPUT_NETWORK_HASH").ok();
    let account = Account::connect(&env("THRUPUT_RPC_URL"), network.as_deref(), secret).await?;
    let mut fhe = Fhe {
        address: contract,
        account,
    };
    let mut rng = Rng::from_phrase(DEMO_PHRASE);
    let sk = SecretKey::generate(&mut rng);
    let mut enc = Rng::from_os();
    match args.first().map(String::as_str) {
        Some("address") => println!("{:?}", fhe.account.address()),
        Some("keyset") => {
            let ek = sk.eval_key(&mut rng);
            // The key's deposit, plus room for 100 gates and their inputs.
            let funds = KEY_DEPOSIT + 100 * (JOB_DEPOSIT + 2 * deposit(8 + LWE_BYTES));
            let keyset = fhe.create_keyset(funds).await?;
            println!("keyset {keyset}: funded with {funds} base units");
            println!("keyset {keyset}: uploading");
            let started = Instant::now();
            // Few transactions in flight: the network is shared.
            fhe.upload_keyset(keyset, &ek, 8, |done, total, receipt| {
                if done % 100 == 0 || done == total {
                    println!("  {done}/{total} ({:?})", receipt.transaction_hash);
                }
            })
            .await?;
            println!(
                "keyset {keyset} sealed in {:.0} s",
                started.elapsed().as_secs_f64()
            );
        }
        Some("nand") => {
            let keyset: u64 = args[1].parse().expect("a keyset id");
            let (x, y) = (bit(args.get(2)), bit(args.get(3)));
            let cx = fhe.put_ciphertext(keyset, &sk.encrypt(x, &mut enc)).await?;
            let cy = fhe.put_ciphertext(keyset, &sk.encrypt(y, &mut enc)).await?;
            let started = Instant::now();
            let report = fhe.gate(Gate::Nand, cx, cy).await?;
            for (tx, gas) in &report.transactions {
                println!("  {tx:?}: {gas} gas");
            }
            println!(
                "NAND({}, {}) = {} (ciphertext {}, {:.1} s)",
                x as u8,
                y as u8,
                sk.decrypt(&report.output) as u8,
                report.output_id,
                started.elapsed().as_secs_f64()
            );
        }
        Some("adder") => {
            let keyset: u64 = args[1].parse().expect("a keyset id");
            let bits = [bit(args.get(2)), bit(args.get(3)), bit(args.get(4))];
            let mut ids = [0u64; 3];
            for (id, &b) in ids.iter_mut().zip(bits.iter()) {
                *id = fhe.put_ciphertext(keyset, &sk.encrypt(b, &mut enc)).await?;
            }
            let started = Instant::now();
            let (sum, carry, reports) = fhe.full_adder(ids[0], ids[1], ids[2]).await?;
            for (g, report) in &reports {
                let gas: u64 = report.transactions.iter().map(|t| t.1).sum();
                println!(
                    "  {g:?}: {} transactions, {gas} gas",
                    report.transactions.len()
                );
            }
            let sum = sk.decrypt(&fhe.get_ciphertext(sum).await?);
            let carry = sk.decrypt(&fhe.get_ciphertext(carry).await?);
            println!(
                "{} + {} + {} = carry {}, sum {} ({:.1} s)",
                bits[0] as u8,
                bits[1] as u8,
                bits[2] as u8,
                carry as u8,
                sum as u8,
                started.elapsed().as_secs_f64()
            );
        }
        Some("decrypt") => {
            let id: u64 = args[1].parse().expect("a ciphertext id");
            let bit = sk.decrypt(&fhe.get_ciphertext(id).await?);
            println!("ciphertext {id} decrypts to {}", bit as u8);
        }
        _ => panic!(
            "usage: fhe-demo address | keyset | nand KEYSET X Y | adder KEYSET A B C | decrypt ID"
        ),
    }
    Ok(())
}
