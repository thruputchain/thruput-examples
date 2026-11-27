//! The README's demo against a deployed FHE contract, on any network:
//!
//! ```text
//! fhe-demo address          # the signer's account address, to fund
//! fhe-demo keyset           # create, upload and seal the demo keyset; prints its id
//! fhe-demo nand KEYSET X Y  # encrypt bits X and Y, evaluate NAND on chain, decrypt
//! fhe-demo adder KEYSET A B C
//! ```
//!
//! Configuration comes from the environment: `THRUPUT_RPC_URL`, `THRUPUT_RUNTIME_MANIFEST`,
//! `FHE_CONTRACT` (the contract's address) and `FHE_SIGNER` (a file holding the base58 secret
//! seed of a funded key, as `thruput keys export NAME -y` writes it; it is never printed).
//!
//! The demo keyset's secret key is derived from [`DEMO_PHRASE`], which is public: anyone can
//! decrypt what is encrypted under it. It demonstrates the mechanics and protects nothing.

use std::time::Instant;

use fhe_client::node::{Account, Fhe};
use fhe_client::{Rng, SecretKey};
use fhe_core::Gate;
use thruput_testkit::xdr::base58;
use thruput_testkit::xdr::types::ContractAddress;
use thruput_testkit::{Agent, NetworkConfig, Scenario};

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
    let secret = std::fs::read_to_string(env("FHE_SIGNER")).expect("read FHE_SIGNER");
    let secret: [u8; 32] = base58::decode_fixed::<32>(secret.trim())
        .expect("FHE_SIGNER holds a base58 seed, as `thruput keys export NAME -y` writes");

    let scenario = Scenario::builder("fhe-demo")
        .network(NetworkConfig::existing(
            env("THRUPUT_RPC_URL"),
            env("THRUPUT_RUNTIME_MANIFEST"),
        ))
        .build()
        .await
        .expect("attach to the network");
    let agent = Agent::new("demo", move |ctx| async move {
        let account = Account::new(ctx.network().clone(), secret).await?;
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
                let keyset = fhe.create_keyset().await?;
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
                let report = fhe.gate(&ctx, Gate::Nand, cx, cy).await?;
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
                let (sum, carry, reports) = fhe.full_adder(&ctx, ids[0], ids[1], ids[2]).await?;
                for (g, report) in &reports {
                    let gas: u64 = report.transactions.iter().map(|t| t.1).sum();
                    println!(
                        "  {g:?}: {} transactions, {gas} gas",
                        report.transactions.len()
                    );
                }
                let sum = sk.decrypt(&fhe.get_ciphertext(&ctx, sum).await?);
                let carry = sk.decrypt(&fhe.get_ciphertext(&ctx, carry).await?);
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
            _ => panic!("usage: fhe-demo keyset | nand KEYSET X Y | adder KEYSET A B C"),
        }
        Ok(())
    });
    let result = scenario.run_agents([agent]).await;
    scenario.stop().await.expect("detach");
    result.expect("the demo ran");
}
