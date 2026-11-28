mod prover;

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use erc20::{ERC20Client, ERC20MetadataClient};
use prover::{KeyShare, Rng};
use secret_ballot::*;
use thruput_sdk::stats::gas_remaining;
use thruput_sdk::*;

fn artifact() -> PathBuf {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target"));
    workspace.join(target).join("thruput/secret_ballot.rv32a")
}

const SECOND: u64 = 1_000_000_000;
const START: u64 = 4_000_000_000 * SECOND;
const CLOSE: u64 = START + 3_600 * SECOND;
const WINDOW: u64 = 86_400 * SECOND;
const BOND: i128 = 1_000;

// The most gas one transaction may budget, on a network that does not configure it.
const MAX_TX_GAS: u64 = 1_000_000_000;

// Run `f` as `caller` in the current block, require it to succeed, and return what it returned
// and the gas it spent.
fn metered<R>(
    env: &TestEnvironmentHandle,
    caller: &ContractAddress,
    f: impl FnOnce() -> R,
) -> (R, u64)
where
    R: WriteXDR + xdr::ReadXDROwned,
{
    let r = env.transact(|tx| {
        tx.call(caller).run(AssertUnwindSafe(|| {
            let before = gas_remaining();
            let returned = f();
            (returned, before - gas_remaining())
        }))
    });
    r.assert_success();
    r.assert_return_as::<(R, u64)>()
}

/// The most each method does, run as RV32 in the executor. Native tests run with the host's
/// memory and no gas metering; this checks that the guest's fixed memory holds the worst case,
/// and that it fits in one transaction's gas.
///
/// A poll with the most options and trustees there can be. A full batch of ballots goes into one
/// station, and one count takes them all. Every trustee decrypts, and the results are published,
/// which checks every trustee's share of every option and refunds every bond.
#[test]
#[ignore = "requires RV32 build — run via `thruput test`"]
fn the_largest_poll_fits_the_guest() {
    let env = TestEnvironment::no_cost();
    let code = env.setup_create_contract(&load_rv32_contract(artifact()));
    let token_code = erc20::register_mock_contract(&env);
    let admin = ContractAddress::named("admin");
    let trustees: Vec<_> = (0..MAX_TRUSTEES)
        .map(|i| ContractAddress::named(&format!("trustee-{i}")))
        .collect();
    env.advance_block_at(START.into());

    let options = MAX_OPTIONS as usize;
    let paper = Paper {
        question: "Which of these?".try_into().unwrap(),
        options: VecM(
            (0..options)
                .map(|i| format!("Option {i}").as_str().try_into().unwrap())
                .collect(),
        ),
    };
    let terms = Terms {
        trustees: VecM(trustees.clone()),
        close: CLOSE,
        decrypt_window: WINDOW,
        bond_token: admin,
        bond: BOND,
    };
    let (mut poll, mut token) = (admin, admin);
    env.transact(|tx| {
        tx.call(&admin).run(AssertUnwindSafe(|| {
            token = deploy_contract(&sha256_static!("token"), token_code.as_hash());
            ERC20MetadataClient::new(&token).initialize(&admin, None, None, Some(2));
            for trustee in &trustees {
                ERC20Client::new(&token).mint(trustee, BOND);
            }
            poll = deploy_contract(&sha256_static!("poll"), &code);
            let terms = Terms {
                bond_token: token,
                ..terms
            };
            SecretBallotClient::new(&poll).initialize(paper, terms);
        }))
    })
    .assert_success();
    env.advance_block();
    let client = SecretBallotClient::new(&poll);

    let voters: Vec<_> = (0..COUNT_BATCH)
        .map(|i| ContractAddress::named(&format!("voter-{i}")))
        .collect();
    let mut registered = 0;
    for batch in voters.chunks(MAX_REGISTER as usize) {
        let batch = VecM(batch.to_vec());
        let (_, gas) = metered(&env, &admin, || client.register(batch));
        registered = registered.max(gas);
    }
    eprintln!("register, {MAX_REGISTER} voters: {registered} gas");

    let mut rng = Rng::new("keys");
    let keys: Vec<_> = trustees.iter().map(|_| KeyShare::new(&mut rng)).collect();
    for trustee in &trustees {
        env.transact(|tx| {
            tx.call(trustee)
                .run(move || ERC20Client::new(&token).adjust_allowance(&poll, BOND))
        })
        .assert_success();
    }
    env.advance_block();
    let mut submitted = 0;
    for (trustee, key) in trustees.iter().zip(&keys) {
        let proof = key.prove(&mut rng, &poll, trustee);
        let (_, gas) = metered(&env, trustee, || client.submit_key(key.public, proof));
        submitted = submitted.max(gas);
    }
    eprintln!("submit_key: {submitted} gas");
    env.advance_block();
    let ((), opened) = metered(&env, &admin, || client.open());
    eprintln!("open, {MAX_TRUSTEES} trustees: {opened} gas");
    env.advance_block();

    // Every ballot goes into station 0, so that one count takes a whole batch.
    let key = prover::poll_key(&keys);
    let mut cast = 0;
    for (i, voter) in voters.iter().enumerate() {
        let ballot = prover::ballot(&mut rng, &poll, voter, &key, options, i % options);
        let ((), gas) = metered(&env, voter, || client.cast(0, ballot));
        cast = cast.max(gas);
    }
    eprintln!("cast, {options} options: {cast} gas");
    assert!(cast < MAX_TX_GAS);
    env.advance_block_at(CLOSE.into());

    let anyone = ContractAddress::named("anyone");
    let (taken, counted) = metered(&env, &anyone, || client.count(0));
    eprintln!("count, {taken} ballots: {counted} gas");
    assert_eq!(taken, COUNT_BATCH);
    assert!(counted < MAX_TX_GAS);
    env.advance_block();

    let ((), finished) = metered(&env, &anyone, || client.finish_count());
    eprintln!("finish_count, {STATIONS} stations: {finished} gas");
    env.advance_block();

    let totals = client_call(&env, &anyone, || client.totals()).expect("counted");
    let mut decrypted = 0;
    for (trustee, key) in trustees.iter().zip(&keys) {
        let shares = key.decrypt(&mut rng, &poll, trustee, &totals[..options]);
        let ((), gas) = metered(&env, trustee, || client.decrypt(shares));
        decrypted = decrypted.max(gas);
    }
    eprintln!("decrypt, {options} options: {decrypted} gas");
    env.advance_block();

    let shares: Vec<Vec<_>> = (0..MAX_TRUSTEES)
        .map(|i| {
            client_call(&env, &anyone, || client.trustee_shares(i))
                .unwrap()
                .0
        })
        .collect();
    let counts = prover::counts(&totals[..options], &shares, u64::from(COUNT_BATCH));
    let per_option = u64::from(COUNT_BATCH) / options as u64;
    assert!(counts.iter().all(|&n| n.abs_diff(per_option) <= 1));
    let published = VecM(counts.clone());
    let ((), gas) = metered(&env, &anyone, || client.publish(published));
    eprintln!("publish, {MAX_TRUSTEES} trustees and {options} options: {gas} gas");
    assert!(gas < MAX_TX_GAS);
    env.advance_block();
    assert_eq!(
        client_call(&env, &anyone, || client.results()),
        Some(VecM(counts))
    );

    let mut reclaimed = 0;
    for trustee in &trustees {
        let ((), gas) = metered(&env, trustee, || client.reclaim());
        reclaimed = reclaimed.max(gas);
    }
    eprintln!("reclaim: {reclaimed} gas");
    env.advance_block();
    let balance = client_call(&env, &anyone, || {
        ERC20Client::new(&token).get_balance_of(&poll)
    });
    assert_eq!(balance, 0);
}

fn client_call<R>(env: &TestEnvironmentHandle, caller: &ContractAddress, f: impl FnOnce() -> R) -> R
where
    R: WriteXDR + xdr::ReadXDROwned,
{
    metered(env, caller, f).0
}
