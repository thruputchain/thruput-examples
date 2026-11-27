//! The contract on a node: upload a keyset, evaluate gates through `crank`, decrypt, and report
//! what it cost. The mock environment of native tests does not meter gas like a node, so this
//! is where the gas figures in the README come from.
//!
//! It is `#[ignore]`d because it needs a running node configured like the hosted network
//! (4,096-byte storage values) and a built artifact; `contracts/fhe/live.sh` sets both up.

use std::path::PathBuf;
use std::time::Instant;

use fhe_client::node::{Account, CRANK_GAS, Fhe, INTERFACE, Job};
use fhe_client::{Rng, SecretKey};
use fhe_core::Gate;
use fhe_core::params::*;
use thruput_testkit::xdr::types::ContractAddress;
use thruput_testkit::xdrs;
use thruput_testkit::{
    Agent, DeployOptions, NetworkConfig, Scenario, TestkitError, WalletInitCall, entrypoint_id,
};

type ERC20Remote = thruput_erc20_if::ERC20Remote<thruput_testkit::Caller>;

/// 1 native token in base units.
const TOKEN: u128 = 10_000_000;

fn fhe_error(e: fhe_client::node::Error) -> TestkitError {
    TestkitError::Manifest {
        field: "fhe",
        detail: e.0,
    }
}

/// What the contract holds beyond keyset 0's recorded funds. Every deposit a keyset's storage
/// takes comes out of that keyset's funds, so this never falls below what it was before the
/// keyset existed; if it did, one keyset's withdrawals could spend tokens another paid in.
async fn slack(fhe: &Fhe, token: &ERC20Remote, when: &str) -> Result<i128, TestkitError> {
    let funds: u128 = fhe
        .account
        .view(fhe.address, "keyset_funds", &0u64)
        .await
        .map_err(fhe_error)?;
    let balance = token.get_balance_of(&fhe.address).await?;
    let slack = balance - funds as i128;
    println!("{when}: keyset funds {funds}, contract balance {balance}, slack {slack}");
    Ok(slack)
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
        // The agent deploys the contract with the network's storage rates and barely any funds
        // of its own (keysets bring theirs), and funds an account of its own signing, which sends
        // calls with more gas than Testkit's default.
        ctx.fund(600 * TOKEN).await?;
        let account = Account::connect(&env("THRUPUT_RPC_URL"), None, [0x5e; 32])
            .await
            .map_err(fhe_error)?;
        let rates = account.storage_rates().await.map_err(fhe_error)?;
        let init = xdrs::cxs::encode(&(rates.item, rates.byte)).expect("encode rates");
        let deployed = ctx
            .deploy_artifact(
                "fhe",
                DeployOptions {
                    // The contract's own code and record of the rates; keysets pay for the rest.
                    amount: TOKEN,
                    initializer: Some(WalletInitCall {
                        entrypoint: entrypoint_id(INTERFACE.0, INTERFACE.1, "initialize"),
                        gas_limit: 20_000_000,
                        calldata: &init,
                    }),
                },
            )
            .await?;
        let mut native = [0u8; 32];
        native[31] = 1;
        let token = ERC20Remote::new(ctx.caller().clone(), &ContractAddress::from(native));
        // The native token pays for its own storage, such as the allowance a keyset's creator
        // grants; on a fresh local node it has none.
        token
            .transfer(&ContractAddress::from(native), TOKEN as i128)
            .await?;
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

        assert_eq!(fhe.check_rates().await.map_err(fhe_error)?, rates);
        let before = slack(&fhe, &token, "deployed").await?;
        let funds = rates.keyset() + 50 * (rates.job() + 2 * rates.ciphertext());
        let keyset = fhe.create_keyset(funds).await.map_err(fhe_error)?;
        assert!(slack(&fhe, &token, "created").await? >= before);
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

        assert!(slack(&fhe, &token, "uploaded").await? >= before);
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
            assert!(slack(&fhe, &token, "after a gate").await? >= before);
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
        let cy = fhe
            .put_ciphertext(keyset, &sk.encrypt(true, &mut enc))
            .await
            .map_err(fhe_error)?;
        let (job, _): (u64, _) = fhe
            .account
            .call(
                fhe.address,
                "start_gate",
                &(Gate::And as u32, cx, cy),
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
        // The owner takes back half of what is left; the contract still covers the rest.
        let left: u128 = fhe
            .account
            .view(fhe.address, "keyset_funds", &0u64)
            .await
            .map_err(fhe_error)?;
        fhe.account
            .call::<_, ()>(fhe.address, "withdraw", &(0u64, left / 2), 20_000_000)
            .await
            .map_err(fhe_error)?;
        assert!(slack(&fhe, &token, "withdrawn").await? >= before);
        Ok(())
    });

    let result = scenario.run_agents([alice]).await;
    scenario.stop().await.expect("detach");
    result.expect("gates evaluate correctly on the node");
}
