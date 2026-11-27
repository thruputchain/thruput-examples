//! The contract on a node: upload a keyset, evaluate gates through `crank`, decrypt, and report
//! what it cost. The mock environment of native tests does not meter gas like a node, so this
//! is where the gas figures in the README come from.
//!
//! It is `#[ignore]`d because it needs a running node configured like the hosted network
//! (4,096-byte storage values) and a built artifact; `contracts/fhe/live.sh` sets both up.

use std::path::PathBuf;
use std::time::Instant;

use fhe_client::node::{Account, CRANK_GAS, Fhe, Job};
use fhe_client::{Rng, SecretKey};
use fhe_core::Gate;
use fhe_core::params::*;
use thruput_testkit::xdr::types::ContractAddress;
use thruput_testkit::{Agent, DeployOptions, NetworkConfig, Scenario, TestkitError};

type ERC20Remote = thruput_erc20_if::ERC20Remote<thruput_testkit::Caller>;

/// 1 native token in base units.
const TOKEN: u128 = 10_000_000;

fn fhe_error(e: fhe_client::node::Error) -> TestkitError {
    TestkitError::Manifest {
        field: "fhe",
        detail: e.0,
    }
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name}; see contracts/fhe/live.sh"))
}

#[tokio::test]
#[ignore = "requires a running node and the built artifact; see contracts/fhe/live.sh"]
async fn gates_on_a_node() {
    let artifact = PathBuf::from(env("THRUPUT_TESTKIT_ARTIFACT_ROOT")).join("fhe.rv32a");
    let scenario = Scenario::builder("fhe")
        .network(NetworkConfig::existing(
            env("THRUPUT_RPC_URL"),
            env("THRUPUT_RUNTIME_MANIFEST"),
        ))
        .artifact("fhe", artifact)
        .build()
        .await
        .expect("attach to the node");

    let alice = Agent::new("alice", |mut ctx| async move {
        // The agent funds the contract (which pays the deposits for the key it stores) and an
        // account of its own signing, which sends calls with more gas than Testkit's default.
        ctx.fund(600 * TOKEN).await?;
        let deployed = ctx
            .deploy_artifact("fhe", DeployOptions::funded(150 * TOKEN))
            .await?;
        let account = Account::connect(&env("THRUPUT_RPC_URL"), None, [0x5e; 32])
            .await
            .map_err(fhe_error)?;
        let mut native = [0u8; 32];
        native[31] = 1;
        let token = ERC20Remote::new(ctx.caller().clone(), &ContractAddress::from(native));
        token
            .transfer(&account.address(), (400 * TOKEN) as i128)
            .await?;
        let mut fhe = Fhe {
            address: deployed.address,
            account,
        };

        let mut rng = Rng::from_phrase("fhe testkit");
        let started = Instant::now();
        let sk = SecretKey::generate(&mut rng);
        let ek = sk.eval_key(&mut rng);
        println!("keygen: {:.1} s", started.elapsed().as_secs_f64());

        let keyset = fhe.create_keyset().await.map_err(fhe_error)?;
        let started = Instant::now();
        let mut upload_gas = (0u64, 0u64);
        fhe.upload_keyset(keyset, &ek, 32, |done, total, receipt| {
            upload_gas.0 += receipt.gas_used;
            upload_gas.1 = upload_gas.1.max(receipt.gas_used);
            if done % 200 == 0 || done == total {
                println!("uploaded {done}/{total}");
            }
        })
        .await
        .map_err(fhe_error)?;
        let uploads = BSK_POLYS.div_ceil(fhe_client::node::POLYS_PER_UPLOAD)
            + KS_GROUPS.div_ceil(fhe_client::node::GROUPS_PER_UPLOAD);
        println!(
            "upload: {uploads} transactions in {:.0} s, {} gas in all, at most {} per transaction",
            started.elapsed().as_secs_f64(),
            upload_gas.0,
            upload_gas.1
        );

        let mut enc = Rng::from_os();
        for (x, y) in [(true, true), (false, true)] {
            let cx = fhe
                .put_ciphertext(keyset, &sk.encrypt(x, &mut enc))
                .await
                .map_err(fhe_error)?;
            let cy = fhe
                .put_ciphertext(keyset, &sk.encrypt(y, &mut enc))
                .await
                .map_err(fhe_error)?;
            let started = Instant::now();
            let report = fhe.gate(Gate::Nand, cx, cy).await.map_err(fhe_error)?;
            let gas: u64 = report.transactions.iter().map(|t| t.1).sum();
            println!(
                "NAND({x}, {y}) = {} in {} transactions, {gas} gas, {:.1} s: {:?}",
                sk.decrypt(&report.output),
                report.transactions.len(),
                started.elapsed().as_secs_f64(),
                report.transactions.iter().map(|t| t.1).collect::<Vec<_>>()
            );
            assert_eq!(sk.decrypt(&report.output), !(x & y));
        }

        // A full adder: five bootstraps, three deep, some on bootstrapped inputs.
        for (a, b, c) in [(true, true, true), (true, false, true)] {
            let [ia, ib, ic] = [a, b, c].map(|v| sk.encrypt(v, &mut enc));
            let ia = fhe.put_ciphertext(keyset, &ia).await.map_err(fhe_error)?;
            let ib = fhe.put_ciphertext(keyset, &ib).await.map_err(fhe_error)?;
            let ic = fhe.put_ciphertext(keyset, &ic).await.map_err(fhe_error)?;
            let started = Instant::now();
            let (sum, carry, reports) = fhe.full_adder(ia, ib, ic).await.map_err(fhe_error)?;
            let sum = sk.decrypt(&fhe.get_ciphertext(sum).await.map_err(fhe_error)?);
            let carry = sk.decrypt(&fhe.get_ciphertext(carry).await.map_err(fhe_error)?);
            let txs: usize = reports.iter().map(|r| r.1.transactions.len()).sum();
            println!(
                "full adder {} + {} + {} = carry {}, sum {}: {txs} transactions, {:.1} s",
                a as u8,
                b as u8,
                c as u8,
                carry as u8,
                sum as u8,
                started.elapsed().as_secs_f64()
            );
            let total = a as u8 + b as u8 + c as u8;
            assert_eq!((carry, sum), (total >= 2, total % 2 == 1));
        }

        // Gas per blind-rotation step: one crank of a fresh job, and how far it got.
        let cx = fhe
            .put_ciphertext(keyset, &sk.encrypt(true, &mut enc))
            .await
            .map_err(fhe_error)?;
        let (job, _): (u64, _) = fhe
            .account
            .call(
                fhe.address,
                "start_gate",
                &(Gate::And as u32, cx, cx),
                20_000_000,
            )
            .await
            .map_err(fhe_error)?;
        let (state, receipt): (Job, _) = fhe
            .account
            .call(fhe.address, "crank", &job, CRANK_GAS)
            .await
            .map_err(fhe_error)?;
        println!(
            "one crank: {} steps for {} gas ({} per step)",
            state.next,
            receipt.gas_used,
            receipt.gas_used / state.next as u64
        );
        Ok(())
    });

    let result = scenario.run_agents([alice]).await;
    scenario.stop().await.expect("detach");
    result.expect("gates evaluate correctly on the node");
}
